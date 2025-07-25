import { differenceInHours, differenceInMinutes, format } from "date-fns";
import { LRUCache } from "lru-cache";

import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  Client,
  ChannelType,
  Message,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import { CHANNELS } from "../constants/channels.js";
import { SlashCommand, isStaff } from "../helpers/discord.js";
import { ReportReasons, reportUser } from "../helpers/modLog.js";
import validate from "./jobs-moderation/validate.js";
import { parseContent } from "./jobs-moderation/parse-content.js";
import {
  loadJobs,
  purgeMember,
  removeSpecificJob,
  untrackModeratedMessage,
  updateJobs,
  trackModeratedMessage,
  failedTooFrequent,
  deleteAgedPosts,
} from "./jobs-moderation/job-mod-helpers.js";
import { getValidationMessage } from "./jobs-moderation/validation-messages.js";
import { FREQUENCY, scheduleTask } from "../helpers/schedule.js";
import {
  POST_FAILURE_REASONS,
  PostFailures,
  PostType,
} from "../types/jobs-moderation.js";

const REPOST_THRESHOLD = 10; // minutes

export const resetJobCacheCommand: SlashCommand = {
  command: new SlashCommandBuilder()
    .setName("reset-job-cache")
    .setDescription("Reset cached posts for the time-based job moderation")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("User to clear post history for")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageMessages,
      // NOTE: 'addUserOption' forces the type to be SlashCommandOptionsOnlyBuilder
      //  which would require to have 'addSubcommand' and 'addSubcommandGroup' methods when registering the command
    ) as SlashCommandBuilder,
  handler: async (interaction) => {
    const { options } = interaction;

    const { user } = options.get("user") || {};
    if (!user) {
      interaction.reply("Must mention a user to clear their post history");
      return;
    }

    const memberToClear = user.id;
    const removed = purgeMember(memberToClear);
    await interaction.reply({
      ephemeral: true,
      content: `Cleared ${removed} posts from ${user?.username} out of cache`,
    });
    return;
  },
};

const rulesThreadCache = new LRUCache<string, ThreadChannel>({
  max: 100,
  ttl: 1000 * 60 * 60 * 2, // 1 hours
  dispose: (value) => {
    value.delete();
  },
});

const jobModeration = async (bot: Client) => {
  const jobBoard = await bot.channels.fetch(CHANNELS.jobBoard);
  if (jobBoard?.type !== ChannelType.GuildText) return;

  // Remove forhire posts that have expired
  scheduleTask("expired post cleanup", FREQUENCY.hourly, () => {
    deleteAgedPosts();
  });
  // Clean up enforcement threads that have been open for more than an hour
  // This _should_ be handled by the cache eviction, but that doesn't appear to
  // be working
  scheduleTask("enforcement thread cleanup", FREQUENCY.hourly, async () => {
    const threads = await jobBoard.threads.fetch({
      archived: { fetchAll: true },
    });
    for (const thread of threads.threads.values()) {
      if (
        !thread.createdAt ||
        differenceInHours(new Date(), thread.createdAt) > 1
      ) {
        await thread.delete();
      }
    }
  });

  await loadJobs(bot, jobBoard);
  await deleteAgedPosts();

  bot.on("messageCreate", async (message) => {
    // Bail if it's a bot or staff message
    if (message.author.bot || isStaff(message.member)) {
      return;
    }
    const { channel } = message;
    // If this is an existing enforcement thread, process the through a "REPL"
    // that lets people test messages against the rules
    if (
      channel.type === ChannelType.PrivateThread &&
      channel.parentId === CHANNELS.jobBoard &&
      channel.ownerId === bot.user?.id
    ) {
      await validationRepl(message);
      return;
    }
    // Bail if this isn't #job-board
    if (
      channel.type !== ChannelType.GuildText ||
      message.channelId !== CHANNELS.jobBoard
    ) {
      return;
    }

    const posts = parseContent(message.content);
    const errors = validate(posts, message);
    console.log(
      `[DEBUG] validating new job post from @${
        message.author.username
      }, errors: ${JSON.stringify(errors)}`,
    );
    if (errors) {
      await handleErrors(channel, message, errors);
    }
  });

  bot.on("messageUpdate", async (_, message) => {
    const { channel } = message;
    if (
      message.author?.bot ||
      message.channelId !== CHANNELS.jobBoard ||
      channel.type !== ChannelType.GuildText ||
      isStaff(message.member)
    ) {
      return;
    }
    if (message.partial) {
      message = await message.fetch();
    }
    const posts = parseContent(message.content);
    // You can't post too frequently when editing a message, so filter those out
    const errors = validate(posts, message).filter(
      (e) => e.type !== POST_FAILURE_REASONS.tooFrequent,
    );
    console.log(
      `[DEBUG] validating edited job post from @${
        message.author.username
      }, errors: ${JSON.stringify(errors)}`,
    );

    if (errors.length > 0) {
      const isRecentEdit =
        differenceInMinutes(new Date(), message.createdAt) < REPOST_THRESHOLD;
      errors.unshift({
        type: POST_FAILURE_REASONS.circumventedRules,
        recentEdit: isRecentEdit,
      });
      if (isRecentEdit) {
        removeSpecificJob(message);
      }
      await handleErrors(channel, message, errors);
      if (posts.some((p) => p.tags.includes(PostType.forHire))) {
        reportUser({ reason: ReportReasons.jobCircumvent, message });
      }
    }
  });

  /*
   * Handle message deletion. There are 3 major cases where messages are removed:
   * - by a moderator
   * - by the poster immediately because of an error
   * - by the poster to try and circumvent our limits
   * - automatically by this bot
   *
   * We don't currently handle messages removed by moderators, we'd need to check * the audit log and there are race conditions there.
   * There's a 10 minute grace period where people are allowed to re-post if they
   * delete their own message.
   * After 10 minutes, they must wait 6.75 days before reposting
   */
  bot.on("messageDelete", async (message) => {
    // TODO: look up audit log, early return if member was banned
    if (
      message.channelId !== CHANNELS.jobBoard ||
      !message.author ||
      isStaff(message.member) ||
      message.author.id === bot.user?.id
    ) {
      return;
    }
    // Don't trigger a message for auto-removed messages
    if (untrackModeratedMessage(message)) {
      return;
    }

    message = message.partial ? await message.fetch() : message;
    const deletedCreation = differenceInMinutes(new Date(), message.createdAt);
    if (deletedCreation < REPOST_THRESHOLD) {
      removeSpecificJob(message);
    }

    // Log deleted job posts publicly
    reportUser({
      reason: ReportReasons.jobRemoved,
      message,
      extra: `Originally sent ${format(new Date(message.createdAt), "P p")}`,
    });
  });
};

export default jobModeration;

const validationRepl = async (message: Message) => {
  const posts = parseContent(message.content);
  const errors = validate(posts, message);

  if (
    message.channel.type !== ChannelType.GuildText &&
    message.channel.type !== ChannelType.PublicThread
  ) {
    return;
  }

  await message.channel.send(
    errors.length > 0
      ? errors.map((e) => `- ${getValidationMessage(e)}`).join("\n")
      : "This post passes our validation rules!",
  );
};

const handleErrors = async (
  channel: TextChannel,
  message: Message,
  errors: ReturnType<typeof validate>,
) => {
  // If the job post is valid, update the list of stored jobs and stop.
  if (errors.length === 0) {
    updateJobs(message);
    return;
  }

  // If there are errors, notify the member and moderate the post.
  trackModeratedMessage(message);
  await message.delete();

  let thread: ThreadChannel;
  const existingThread = rulesThreadCache.get(message.author.id);
  if (existingThread) {
    thread = existingThread;
    await existingThread.send(
      `Hey <@${
        message.author.id
      }>, please use this thread to test out new posts against our validation rules. Your was removed for these reasons:

${errors.map((e) => `- ${getValidationMessage(e)}`).join("\n")}`,
    );
  } else {
    thread = await channel.threads.create({
      name: "Your post has been removed",
      type: ChannelType.PrivateThread,
      invitable: false,
    });
    rulesThreadCache.set(message.author.id, thread);
    await thread.send({
      content: `Hey <@${
        message.author.id
      }>, your message does not meet our requirements to be posted to the board. This thread acts as a REPL where you can test out new posts against our validation rules. It was removed for these reasons:

${errors.map((e) => `- ${getValidationMessage(e)}`).join("\n")}

View our [guidance for job posts](<https://www.reactiflux.com/promotion#job-board>).`,
      embeds: [
        {
          description: `Here's an example of a good HIRING post:
\`\`\`
HIRING | REMOTE | FULL-TIME

Senior React Engineer: $min - $max

Lorem ipsum dolor sit amet, consectetur adipisicing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

More details & apply: https://example.com/apply
\`\`\``,
          color: 0x7289da,
        },
      ],
    });
  }

  // Handle missing post type
  const error: PostFailures | undefined = errors.find(failedTooFrequent);
  if (error) {
    reportUser({ reason: ReportReasons.jobFrequency, message });
  }

  await thread.send("Your post:");
  await thread.send({
    content: message.content,
    allowedMentions: { users: [] },
  });
};
