import {
  MessageReaction,
  Message,
  GuildMember,
  Guild,
  EmbedType,
  ChannelType,
} from "discord.js";
import cooldown from "./cooldown.js";
import type { ChannelHandlers } from "../types/index.d.ts";
import {
  ReportReasons,
  reportUser,
  truncateMessage,
} from "../helpers/modLog.js";
import {
  createPrivateThreadFromMessage,
  fetchReactionMembers,
  isStaff,
  isStaffOrHelpful,
} from "../helpers/discord.js";
import { partition } from "../helpers/array.js";
import { EMBED_COLOR } from "./commands.js";
import { logger } from "./log.js";

const config = {
  // This is how many ️️warning reactions a post must get until it's considered an official warning
  warningThreshold: 1,
  // This is how many ️️warning reactions a post must get until mods are alerted
  thumbsDownThreshold: 2,
  // This is how many ️️warning reactions a post must get the message is deleted
  deletionThreshold: Infinity,
};

const thumbsDownEmojis = ["👎", "👎🏻", "👎🏼", "👎🏽", "👎🏾", "👎🏿"];

type ReactionHandlers = {
  [emoji: string]: (args: {
    guild: Guild;
    reaction: MessageReaction;
    message: Message;
    reactor: GuildMember;
    author: GuildMember;
    usersWhoReacted: GuildMember[];
  }) => void;
};

export const reactionHandlers: ReactionHandlers = {
  "👎": async ({ message, reactor, usersWhoReacted }) => {
    if (cooldown.hasCooldown(reactor.id, "thumbsdown")) {
      return;
    }

    if (message.mentions.everyone || message.mentions.roles.size > 0) {
      return;
    }

    cooldown.addCooldown(reactor.id, "thumbsdown", 60); // 1 minute

    const totalReacts = usersWhoReacted.length;

    if (totalReacts < config.thumbsDownThreshold) {
      return;
    }
    let reason = ReportReasons.userWarn;
    if (totalReacts >= config.deletionThreshold) {
      reason = ReportReasons.userDelete;
    }

    const staffReactionCount = usersWhoReacted.filter(isStaff).length;
    const [staff, members] = partition(isStaff, usersWhoReacted);
    const meetsDeletion = staffReactionCount >= config.deletionThreshold;

    if (meetsDeletion) {
      message.delete();
    }

    reportUser({ reason, message, staff, members });
  },
  "🔍": async ({ message, usersWhoReacted }) => {
    const STAFF_OR_HELPFUL_REACTOR_THRESHOLD = 2;

    const staffOrHelpfulReactors = usersWhoReacted.filter(isStaffOrHelpful);

    const { channel } = message;
    if (
      staffOrHelpfulReactors.length < STAFF_OR_HELPFUL_REACTOR_THRESHOLD ||
      channel.type === ChannelType.PublicThread
    ) {
      return;
    }

    const thread = await createPrivateThreadFromMessage(message, {
      name: `Sorry ${message.author.username}, your question needs some work`,
      autoArchiveDuration: 60,
    });

    await thread.send({
      embeds: [
        {
          title: "Please improve your question",
          type: EmbedType.Rich,
          description: `
Sorry, our most active helpers have flagged this as a question that needs more work before a good answer can be given. This may be because it's ambiguous, too broad, or otherwise challenging to answer.

Zell Liew [wrote a great resource](https://zellwk.com/blog/asking-questions/) about asking good programming questions.

- The onus is on the asker to craft a question that is easy to answer.
- A good question is specific, clear, concise, and shows effort on the part of the asker.
- Share just the relevant parts of the code, using tools like Codepen, CodeSandbox, or GitHub for better clarity.
- Making a question specific and to the point is a sign of respecting the responder’s time, which increases the likelihood of getting a good answer.

(this was triggered by crossing a threshold of "🔍" reactions on the original message)
          `,
          color: EMBED_COLOR,
        },
      ],
    });
    await thread.send("Your message:");
    await thread.send(truncateMessage(message.content));

    await message.delete();

    reportUser({
      reason: ReportReasons.lowEffortQuestionRemoved,
      message,
      staff: staffOrHelpfulReactors,
    });
  },
};

const emojiMod: ChannelHandlers = {
  handleReaction: async ({ reaction, user, bot }) => {
    const { message } = reaction;
    const { guild } = message;

    if (!guild) {
      return;
    }

    let emoji = reaction.emoji.toString();

    if (thumbsDownEmojis.includes(emoji)) {
      emoji = "👎";
    }

    if (!reactionHandlers[emoji]) {
      return;
    }
    try {
      const [fullReaction, fullMessage, reactor] = await Promise.all([
        reaction.partial ? reaction.fetch() : reaction,
        message.partial ? message.fetch() : message,
        guild.members.fetch(user.id),
      ]);
      const [usersWhoReacted, authorMember] = await Promise.all([
        fetchReactionMembers(guild, fullReaction),
        guild.members.fetch(fullMessage.author.id),
      ]);

      if (authorMember.id === bot.user?.id) return;

      reactionHandlers[emoji]({
        guild,
        author: authorMember,
        reactor,
        message: fullMessage,
        reaction: fullReaction,
        usersWhoReacted: usersWhoReacted.filter(
          (x): x is GuildMember => Boolean(x) && authorMember.id !== reactor.id,
        ),
      });
    } catch (e) {
      if (e instanceof Error) {
        let descriptiveMessage = `Channel id: ${message.channelId}`;
        if (message.channel.isThread()) {
          const thread = message.channel;
          descriptiveMessage += `Thread id: ${thread.id}`;
        }
        logger.log(
          `${descriptiveMessage} username: ${user.username}  message: ${message.content}`,
          e,
        );
      }
      throw e;
    }
  },
};

export default emojiMod;
