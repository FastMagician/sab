require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ======================= BASIC CONFIG =======================

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("No TOKEN found in .env file.");
  process.exit(1);
}

// devs
const DEVELOPER_IDS = ["1435574411070537789", "1440832423624704030"];
const PREFIX = ".";

const settingsPath = path.join(__dirname, "settings.json");

// base command names that can have aliases
const DEFAULT_ALIASES = {
  panel: "panel",
  useless: "useless",
  important: "important",
  done: "done",
  nuke: "nuke",
  hi: "hi",
  pingtickets: "pingtickets",
  help: "help",
  setlogs: "setlogs",
  pingrole: "pingrole",
  ar: "ar",
  send: "send",
  sendcategory: "sendcategory",
  delayset: "delayset",
  admin: "admin",
  blacklist: "blacklist",
  setcmd: "setcmd",
  setticketcategory: "setticketcategory"
};

// default settings
let settings = {
  categoryId: "1440036261707386900", // main "ticket" category
  ticketCategories: [],
  admins: [],
  importantCategoryId: null,
  logsChannelId: null,
  autoresponders: {},
  autoSendTrigger: null,
  autoSendCategoryId: null,
  autoDelaySeconds: 0,
  notifyRoleId: null,
  ticketCounter: 659,
  blacklist: [],
  commandAliases: { ...DEFAULT_ALIASES }
};

// scam words
const SCAM_WORDS = [
  "scam",
  "scammer",
  "scammers",
  "scamming",
  "scammed",
  "skam",
  "scamm"
];

// load settings
if (fs.existsSync(settingsPath)) {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    settings = { ...settings, ...parsed };
  } catch (err) {
    console.error("Failed to read settings.json:", err);
  }
}

// ensure arrays / aliases exist
if (!Array.isArray(settings.ticketCategories)) {
  settings.ticketCategories = [];
}
if (
  settings.categoryId &&
  !settings.ticketCategories.includes(settings.categoryId)
) {
  settings.ticketCategories.unshift(settings.categoryId);
}

if (!settings.commandAliases) {
  settings.commandAliases = { ...DEFAULT_ALIASES };
} else {
  for (const [key, defAlias] of Object.entries(DEFAULT_ALIASES)) {
    if (!settings.commandAliases[key]) {
      settings.commandAliases[key] = defAlias;
    }
  }
}

if (!Array.isArray(settings.blacklist)) {
  settings.blacklist = [];
}

// admins (plus devs)
const adminSet = new Set(settings.admins || []);
for (const id of DEVELOPER_IDS) adminSet.add(id);

// blacklist cache
const blacklist = new Set(settings.blacklist || []);

// save settings helper
function saveSettings() {
  settings.blacklist = Array.from(blacklist);

  const toSave = {
    categoryId: settings.categoryId,
    ticketCategories: settings.ticketCategories,
    admins: Array.from(adminSet).filter(id => !DEVELOPER_IDS.includes(id)),
    importantCategoryId: settings.importantCategoryId || null,
    logsChannelId: settings.logsChannelId || null,
    autoresponders: settings.autoresponders || {},
    autoSendTrigger: settings.autoSendTrigger || null,
    autoSendCategoryId: settings.autoSendCategoryId || null,
    autoDelaySeconds:
      typeof settings.autoDelaySeconds === "number"
        ? settings.autoDelaySeconds
        : 0,
    notifyRoleId: settings.notifyRoleId || null,
    ticketCounter: settings.ticketCounter || 659,
    blacklist: settings.blacklist,
    commandAliases: settings.commandAliases || { ...DEFAULT_ALIASES }
  };
  fs.writeFileSync(settingsPath, JSON.stringify(toSave, null, 2), "utf8");
}

// ticket info
const ticketInfoSent = new Set();
const ticketTimeouts = new Map();
const ticketCountdowns = new Map();
const ticketReminders = new Map();
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// who opened / claimed which ticket
const ticketOwners = new Map();
const ticketClaims = new Map();

// 1 ticket per person: userId -> channelId (for **currently open** tickets)
const activeTickets = new Map();

// ======================= CLIENT =======================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// ready
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ======================= HELPERS =======================

function isDeveloper(id) {
  return DEVELOPER_IDS.includes(id);
}

function isAdmin(id) {
  return isDeveloper(id) || adminSet.has(id);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getLogsChannel(guild) {
  if (!settings.logsChannelId) return null;
  const cached = guild.channels.cache.get(settings.logsChannelId);
  if (cached && cached.type === ChannelType.GuildText) return cached;
  try {
    const fetched = await guild.channels.fetch(settings.logsChannelId);
    if (fetched && fetched.type === ChannelType.GuildText) return fetched;
  } catch {
    return null;
  }
  return null;
}

async function logAction(guild, embed) {
  const logsChannel = await getLogsChannel(guild);
  if (!logsChannel) return;
  try {
    await logsChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to send log:", err);
  }
}

// map typed command name → base command using aliases
function getCanonicalCommand(name) {
  if (!name) return "";
  name = name.toLowerCase();
  const aliases = settings.commandAliases || {};
  for (const [base, alias] of Object.entries(aliases)) {
    if (alias && alias.toLowerCase() === name) return base;
  }
  return name;
}

// ping staff role + all viewers without admin
async function pingWatchers(channel) {
  try {
    if (!channel || !channel.guild) return;

    const mentions = [];

    if (settings.notifyRoleId) {
      const role = channel.guild.roles.cache.get(settings.notifyRoleId);
      if (role) mentions.push(`<@&${role.id}>`);
    }

    const viewers = channel.members.filter(m => {
      if (!m) return false;
      if (m.user.bot) return false;
      if (m.permissions.has(PermissionsBitField.Flags.Administrator)) return false;
      return true;
    });

    viewers.forEach(m => mentions.push(`<@${m.id}>`));

    if (!mentions.length) return;

    await channel.send(mentions.join(" "));
  } catch (err) {
    console.error("Failed to ping watchers:", err);
  }
}

// find the pinned ticket panel message in a channel
async function getTicketPanelMessage(channel) {
  try {
    const pins = await channel.messages.fetchPinned();
    const panel = pins.find(
      m =>
        m.author.id === client.user.id &&
        m.components?.length &&
        m.components[0].components.some(
          c => c.customId === "ticket_close"
        )
    );
    return panel || null;
  } catch {
    return null;
  }
}

// close & delete a channel
async function closeTicketChannel(channel, closedByUser, reasonText) {
  if (!channel || !channel.guild) return;
  clearTicketState(channel.id);

  const embed = new EmbedBuilder()
    .setTitle("channel closed by staff")
    .setColor(0x2b2d31)
    .addFields(
      { name: "channel", value: `${channel.name} (${channel.id})`, inline: true },
      {
        name: "by",
        value: `${closedByUser.tag} (${closedByUser.id})`,
        inline: true
      }
    )
    .setTimestamp();

  if (reasonText) {
    embed.addFields({ name: "reason", value: reasonText.slice(0, 400) });
  }

  await logAction(channel.guild, embed);

  setTimeout(async () => {
    try {
      await channel.delete("Ticket closed by staff");
    } catch (err) {
      console.error("Failed to delete ticket channel:", err);
    }
  }, 500);
}

function scheduleTicketDeletion(channelId, expiresAt) {
  if (ticketTimeouts.has(channelId)) return;

  const delay = Math.max(0, expiresAt - Date.now());

  const timeout = setTimeout(async () => {
    ticketTimeouts.delete(channelId);
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      return;
    }
    if (!channel || channel.deleted) return;

    const embed = new EmbedBuilder()
      .setTitle("ticket closed (expired)")
      .setDescription("this ticket was open for 6 hours and has been closed.")
      .addFields({ name: "channel", value: `<#${channel.id}>` })
      .setColor(0x2b2d31)
      .setTimestamp();

    await logAction(channel.guild, embed);

    try {
      await channel.delete("Ticket expired after 6 hours");
    } catch (err) {
      console.error("Failed to delete expired ticket:", err);
    }
  }, delay);

  ticketTimeouts.set(channelId, timeout);
}

function clearTicketState(channelId) {
  if (ticketTimeouts.has(channelId)) {
    clearTimeout(ticketTimeouts.get(channelId));
    ticketTimeouts.delete(channelId);
  }
  if (ticketCountdowns.has(channelId)) {
    clearInterval(ticketCountdowns.get(channelId));
    ticketCountdowns.delete(channelId);
  }
  if (ticketReminders.has(channelId)) {
    clearTimeout(ticketReminders.get(channelId));
    ticketReminders.delete(channelId);
  }
  ticketInfoSent.delete(channelId);

  // clear active ticket + ownership
  const ownerId = ticketOwners.get(channelId);
  if (ownerId) {
    activeTickets.delete(ownerId);
  }
  ticketOwners.delete(channelId);
  ticketClaims.delete(channelId);
}

function buildTicketEmbed(remainingMs) {
  if (remainingMs < 0) remainingMs = 0;

  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor(
    (remainingMs % (60 * 60 * 1000)) / (60 * 1000)
  );

  let timeText;
  if (hours <= 0 && minutes <= 0) {
    timeText = "0 minutes";
  } else if (hours <= 0) {
    timeText = `${minutes} minutes`;
  } else if (minutes === 0) {
    timeText = `${hours} hours`;
  } else {
    timeText = `${hours} hours ${minutes} minutes`;
  }

  const lines = [
    "do you have any brainrots that are $100m+ that i can hold onto incase you try to scam me, or try to exploit.",
    "(not saying you're gonna, but for caution) send a screenshot of all your 100m+ brainrots and also type out",
    "the exact brainrot(s) you will be letting me hold so i can confirm. **OUR PS ONLY**",
    "",
    `if you do not send valid screenshots within ${timeText}, this ticket will be deleted.`,
    "",
    "please wait patiently while staff reviews your brainrots.",
    "",
    "do not ping katie048937 in this channel."
  ];

  return new EmbedBuilder()
    .setTitle("RULES, READ BEFORE DOING ANYTHING ELSE")
    .setDescription(lines.join("\n"))
    .setColor(0x2b2d31);
}

function startTicketCountdown(channelId, messageId, createdAt, expiresAt) {
  if (ticketCountdowns.has(channelId)) return;

  const totalMs = expiresAt - createdAt;
  if (totalMs <= 0) return;

  const interval = setInterval(async () => {
    const now = Date.now();
    const remainingMs = expiresAt - now;
    if (remainingMs <= 0) {
      clearInterval(interval);
      ticketCountdowns.delete(channelId);
      return;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (!msg) return;

      const embed = buildTicketEmbed(remainingMs);
      await msg.edit({ embeds: [embed] });
    } catch (err) {
      console.error("Countdown update failed:", err);
      clearInterval(interval);
      ticketCountdowns.delete(channelId);
    }
  }, 60 * 1000);

  ticketCountdowns.set(channelId, interval);
}

function setTicketReminder(channelId) {
  if (ticketReminders.has(channelId)) {
    clearTimeout(ticketReminders.get(channelId));
    ticketReminders.delete(channelId);
  }

  const timeout = setTimeout(async () => {
    ticketReminders.delete(channelId);
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.deleted || !channel.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setTitle("ticket reminder")
        .setDescription(
          "this ticket has been inactive for a while. please send your screenshots or reply.\nif nothing is sent, this ticket will auto-close soon."
        )
        .setColor(0x2b2d31);

      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.error("Failed to send ticket reminder:", err);
    }
  }, FOUR_HOURS_MS);

  ticketReminders.set(channelId, timeout);
}

async function startTicketFlowForChannel(channel) {
  if (!channel || !channel.guild) return;

  // only trigger in configured ticket categories
  if (
    !channel.parentId ||
    !settings.ticketCategories.includes(channel.parentId)
  ) {
    return;
  }

  if (!ticketInfoSent.has(channel.id)) {
    ticketInfoSent.add(channel.id);

    const remainingMs = SIX_HOURS_MS;
    const embed = buildTicketEmbed(remainingMs);

    let sent;
    try {
      sent = await channel.send({ embeds: [embed] });
    } catch (err) {
      console.error("Failed to send ticket embed:", err);
      return;
    }

    // ping the owner UNDER the embed (only after embed is sent)
    const ownerId = ticketOwners.get(channel.id);
    if (ownerId) {
      try {
        await channel.send(`<@${ownerId}>`);
      } catch {}
    }

    const createdAt = Date.now();
    const expiresAt = createdAt + SIX_HOURS_MS;
    startTicketCountdown(channel.id, sent.id, createdAt, expiresAt);
    scheduleTicketDeletion(channel.id, expiresAt);
  }

  setTicketReminder(channel.id);
}

// autoresponder for non-command messages
async function handleAutoresponderMessage(message) {
  const autores = settings.autoresponders || {};
  const triggers = Object.keys(autores);
  if (!triggers.length) return;

  const contentLower = message.content.toLowerCase();

  for (const key of triggers) {
    const trigger = key.toLowerCase().trim();
    if (!trigger) continue;

    let matched = false;
    if (contentLower.includes(trigger)) {
      matched = true;
    } else {
      const triggerWords = trigger.split(/\s+/).filter(w => w.length >= 3);
      for (const tw of triggerWords) {
        if (contentLower.includes(tw)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) continue;

    let resp = autores[key] || "";
    if (!resp) return;

    resp = resp.replace(/\{user\}/gi, `<@${message.author.id}>`);

    try {
      const delayMs =
        typeof settings.autoDelaySeconds === "number"
          ? settings.autoDelaySeconds * 1000
          : 0;
      if (delayMs > 0) await sleep(delayMs);

      await message.channel.send(resp);
    } catch (err) {
      console.error("Failed to send autoresponse:", err);
    }

    const embed = new EmbedBuilder()
      .setTitle("autoresponder used")
      .setColor(0x2b2d31)
      .addFields(
        { name: "channel", value: `<#${message.channel.id}>`, inline: true },
        {
          name: "by",
          value: `${message.author.tag} (${message.author.id})`,
          inline: true
        },
        { name: "trigger", value: "`" + trigger + "`", inline: false },
        { name: "user message", value: message.content.slice(0, 400) }
      )
      .setTimestamp();

    await logAction(message.guild, embed);
    break;
  }
}

// pick ticket category, create overflow if full (>= 50 channels)
async function pickTicketCategory(guild) {
  const catIds = settings.ticketCategories || [];
  const validCats = [];

  for (const id of catIds) {
    const cat = guild.channels.cache.get(id);
    if (cat && cat.type === ChannelType.GuildCategory) validCats.push(cat);
  }

  if (!validCats.length) return null;

  for (const cat of validCats) {
    const count = guild.channels.cache.filter(c => c.parentId === cat.id).size;
    if (count < 50) return cat;
  }

  const base = validCats[0];
  const newName = `${base.name}-${validCats.length + 1}`;

  let newCat;
  try {
    newCat = await guild.channels.create({
      name: newName,
      type: ChannelType.GuildCategory
    });
  } catch (err) {
    console.error("Failed to create overflow ticket category:", err);
    return base;
  }

  settings.ticketCategories.push(newCat.id);
  saveSettings();
  return newCat;
}

// help embeds
function buildHelpEmbed(page) {
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTimestamp();

  if (page === 1) {
    embed
      .setTitle("help – tickets & panels (page 1/3)")
      .setDescription(
        [
          "**panel** – send ticket panel embed with button. if a category is given, tickets go there.",
          "**useless** – move a channel into the main ticket category.",
          "**important** – move channel into the important category.",
          "**pingtickets** – ping the ticket opener in all active ticket channels.",
          "**done** – deletes the current channel.",
          "**nuke** – clone the current channel, delete the old one, and continue here.",
          "",
          "tickets auto:",
          "- send the line embed with countdown and $100m+ instructions",
          "- remind after 4h, close after 6h"
        ].join("\n")
      );
  } else if (page === 2) {
    embed
      .setTitle("help – admin / mod (page 2/3)")
      .setDescription(
        [
          "**admin set <user>** – add another admin for this bot.",
          "**admin category <category>** – set main ticket category (useless).",
          "**admin importantcategory <category>** – set important category.",
          "**setticketcategory <category>** – shortcut to set main ticket category.",
          "**setlogs <channel>** – set logs channel.",
          "**pingrole <role>** – set staff role to ping (and used for KING role mention).",
          "**blacklist <user>** – block a user from opening tickets (add remove/list)."
        ].join("\n")
      );
  } else {
    embed
      .setTitle("help – autoresponder & automation (page 3/3)")
      .setDescription(
        [
          "**ar set word, response** – create an autoresponder.",
          "**ar delete word** – delete autoresponder.",
          "**ar list** – list autoresponders.",
          "**send word** – choose which autoresponder text auto-sends on new channels in a category (not tickets).",
          "**sendcategory <category>** – category where auto-send is used for new channels.",
          "**delayset <seconds>** – delay before autoresponder / auto-send messages.",
          "**hi** – reply to a message then run hi to rename the channel from that text."
        ].join("\n")
      );
  }

  embed.setFooter({
    text: "note: actual command words can be renamed with setcmd"
  });

  return embed;
}

function buildHelpRow(page) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("help_1")
      .setLabel("1")
      .setStyle(page === 1 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help_2")
      .setLabel("2")
      .setStyle(page === 2 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help_3")
      .setLabel("3")
      .setStyle(page === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help_close")
      .setLabel("close")
      .setStyle(ButtonStyle.Danger)
  );
}

// ======================= EVENTS =======================

// auto-send + ping in sendcategory (NOT ticket panel; separate feature)
client.on("channelCreate", async channel => {
  try {
    if (!channel.guild) return;
    if (typeof channel.isTextBased !== "function" || !channel.isTextBased())
      return;

    if (
      settings.autoSendCategoryId &&
      channel.parentId === settings.autoSendCategoryId &&
      settings.autoSendTrigger &&
      settings.autoresponders &&
      settings.autoresponders[settings.autoSendTrigger]
    ) {
      let msgText = settings.autoresponders[settings.autoSendTrigger];
      msgText = msgText.replace(/\{user\}/gi, "");

      const delayMs =
        typeof settings.autoDelaySeconds === "number"
          ? settings.autoDelaySeconds * 1000
          : 0;
      if (delayMs > 0) await sleep(delayMs);

      await channel.send(msgText);
      await pingWatchers(channel);
    }
  } catch (err) {
    console.error("channelCreate auto-send failed:", err);
  }
});

// ======================= INTERACTIONS (buttons only) =======================

client.on("interactionCreate", async interaction => {
  // no slash commands – only buttons
  if (!interaction.isButton()) return;

  const { guild, user } = interaction;

  // ticket open button
  if (interaction.customId === "open_ticket") {
    if (!guild) return;

    if (blacklist.has(user.id)) {
      return interaction.reply({
        content: "you are blacklisted from creating tickets.",
        ephemeral: true
      });
    }

    // 1 ticket per user check (for currently open tickets)
    if (activeTickets.has(user.id)) {
      const chId = activeTickets.get(user.id);
      return interaction.reply({
        content: `you already have an open ticket: <#${chId}>`,
        ephemeral: true
      });
    }

    const ticketCategory = await pickTicketCategory(guild);
    if (!ticketCategory) {
      return interaction.reply({
        content: "ticket category is not configured.",
        ephemeral: true
      });
    }

    const num = settings.ticketCounter || 659;
    settings.ticketCounter = num + 1;
    saveSettings();

    const channelName = `ticket-${num}`;
    const everyoneId = guild.roles.everyone.id;

    const overwrites = [
      {
        id: everyoneId,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels
        ]
      }
    ];

    for (const adminId of adminSet) {
      const member = guild.members.cache.get(adminId);
      if (!member) continue;
      overwrites.push({
        id: adminId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      });
    }

    let ticketChannel;
    try {
      ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: ticketCategory.id,
        permissionOverwrites: overwrites
      });
    } catch (err) {
      console.error("Failed to create ticket channel:", err);
      return interaction.reply({
        content: "could not create a ticket channel.",
        ephemeral: true
      });
    }

    ticketOwners.set(ticketChannel.id, user.id);
    activeTickets.set(user.id, ticketChannel.id);

    await interaction.reply({
      content: `ticket created: <#${ticketChannel.id}>`,
      ephemeral: true
    });

    // FIRST message: spoiler ping KING role ONLY
    const kingRoleId = settings.notifyRoleId || "1423283486222979234";
    try {
      await ticketChannel.send(`|| <@&${kingRoleId}> ||`);
    } catch (err) {
      console.error("Failed to send spoiler ping:", err);
    }

    // SECOND: control panel embed + buttons (pinned)
    const controlEmbed = new EmbedBuilder()
      .setTitle("thank you for opening a ticket.")
      .setDescription("please wait for a staff member to contact you.")
      .setColor(0x2b2d31);

    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket_close")
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("ticket_close_reason")
        .setLabel("Close With Reason")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ticket_claim")
        .setLabel("Claim")
        .setStyle(ButtonStyle.Success)
    );

    const controlMsg = await ticketChannel.send({
      embeds: [controlEmbed],
      components: [controlRow]
    });

    try {
      await controlMsg.pin();
    } catch (err) {
      console.error("Failed to pin ticket control message:", err);
    }

    // THIRD: 100m collateral embed + ping user + timers
    await startTicketFlowForChannel(ticketChannel);

    return;
  }

  // ticket button: Close
  if (interaction.customId === "ticket_close") {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    if (!isAdmin(user.id)) {
      return interaction.reply({
        content: "only staff can close tickets.",
        ephemeral: true
      });
    }

    await interaction.reply({ content: "closing ticket...", ephemeral: true });
    await closeTicketChannel(channel, user, null);
    return;
  }

  // ticket button: Close with reason
  if (interaction.customId === "ticket_close_reason") {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    if (!isAdmin(user.id)) {
      return interaction.reply({
        content: "only staff can close tickets.",
        ephemeral: true
      });
    }

    await interaction.reply({
      content: "send the close reason in this channel (you have 2 minutes).",
      ephemeral: true
    });

    try {
      const collected = await channel.awaitMessages({
        filter: m => m.author.id === user.id && !m.author.bot,
        max: 1,
        time: 120000,
        errors: ["time"]
      });

      const reasonMsg = collected.first();
      const reasonText = reasonMsg ? reasonMsg.content : "no reason given";

      await closeTicketChannel(channel, user, reasonText);
    } catch {
      await channel.send(
        "no reason provided in time. closing without a reason."
      );
      await closeTicketChannel(channel, user, null);
    }
    return;
  }

  // ticket button: Claim
  if (interaction.customId === "ticket_claim") {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    if (!isAdmin(user.id)) {
      return interaction.reply({
        content: "only staff can claim tickets.",
        ephemeral: true
      });
    }

    const currentClaim = ticketClaims.get(channel.id);
    if (currentClaim) {
      return interaction.reply({
        content: `this ticket is already claimed by <@${currentClaim}>.`,
        ephemeral: true
      });
    }

    ticketClaims.set(channel.id, user.id);

    const panelMsg = await getTicketPanelMessage(channel);
    if (panelMsg) {
      const oldEmbed = panelMsg.embeds[0];
      const newEmbed = EmbedBuilder.from(oldEmbed).setFooter({
        text: `claimed by ${user.tag}`
      });
      await panelMsg.edit({
        embeds: [newEmbed],
        components: panelMsg.components
      });
    }

    await interaction.reply({
      content: "you have claimed this ticket.",
      ephemeral: true
    });
    return;
  }

  // help buttons
  if (interaction.customId.startsWith("help_")) {
    if (!isAdmin(user.id)) {
      return interaction.reply({
        content: "you are not allowed to use this.",
        ephemeral: true
      });
    }

    if (interaction.customId === "help_close") {
      try {
        await interaction.message.delete();
      } catch {}
      return;
    }

    let page = 1;
    if (interaction.customId === "help_2") page = 2;
    if (interaction.customId === "help_3") page = 3;

    const embed = buildHelpEmbed(page);
    const row = buildHelpRow(page);

    await interaction.update({ embeds: [embed], components: [row] });
  }
});

// ======================= MESSAGE HANDLER =======================

client.on("messageCreate", async message => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const contentLower = message.content.toLowerCase();

  // ---- scam filter: delete message ONLY (no timeout, no ban) ----
  if (SCAM_WORDS.some(w => contentLower.includes(w))) {
    if (!isAdmin(message.author.id)) {
      const user = message.author;

      const embed = new EmbedBuilder()
        .setTitle("scam filter – message deleted")
        .setColor(0xff0000)
        .addFields(
          { name: "user", value: `${user.tag} (${user.id})` },
          { name: "channel", value: `<#${message.channel.id}>` },
          {
            name: "message",
            value: message.content.slice(0, 400) || "no content"
          }
        )
        .setTimestamp();

      await logAction(message.guild, embed);

      try {
        await message.delete();
      } catch {
        // ignore
      }
    }
  }

  // ticket message detection (any ticket category)
  if (
    message.channel.parentId &&
    settings.ticketCategories.includes(message.channel.parentId)
  ) {
    await startTicketFlowForChannel(message.channel);
  }

  // autoresponder for non-commands
  if (!message.content.startsWith(PREFIX)) {
    await handleAutoresponderMessage(message);
    return;
  }

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const rawCommand = args.shift()?.toLowerCase() || "";
  const command = getCanonicalCommand(rawCommand);

  // all commands require admin
  if (!isAdmin(message.author.id)) {
    return;
  }

  // aaa – developer-only channel delete command
  if (command === "aaa") {
    if (!isDeveloper(message.author.id)) {
      return message.reply("this command is developer-only.");
    }

    const mentioned = message.mentions.channels.first();
    const idMatch = args[0] && args[0].match(/\d{17,20}/);
    const provided = idMatch && message.guild.channels.cache.get(idMatch[0]);

    const targetChannel = mentioned || provided || message.channel;

    if (!targetChannel?.deletable) {
      return message.reply("i cannot delete that channel.");
    }

    const embed = new EmbedBuilder()
      .setTitle("channel deleted")
      .setColor(0xff0000)
      .addFields(
        { name: "channel", value: `<#${targetChannel.id}>`, inline: true },
        {
          name: "by",
          value: `${message.author.tag} (${message.author.id})`,
          inline: true
        },
        { name: "name", value: targetChannel.name || "(no name)", inline: false }
      )
      .setTimestamp();

    await logAction(message.guild, embed);

    if (targetChannel.id === message.channel.id) {
      await message.reply("deleting this channel...");
    } else {
      await message.reply(`deleting channel <#${targetChannel.id}>...`);
    }

    try {
      await targetChannel.delete(
        `deleted by ${message.author.tag} (${message.author.id}) via .aaa`
      );
    } catch (err) {
      console.error("Developer delete failed:", err);
      return message.reply("failed to delete that channel.");
    }

    return;
  }

  // setcmd – change command aliases
  if (command === "setcmd") {
    const base = args.shift()?.toLowerCase();
    const alias = args.shift()?.toLowerCase();

    if (!base || !alias) {
      return message.reply(
        "usage: .setcmd baseName newName\nexample: .setcmd panel ticketpanel"
      );
    }

    if (!Object.prototype.hasOwnProperty.call(DEFAULT_ALIASES, base)) {
      return message.reply(
        "that base command cannot be renamed. valid base commands:\n" +
          Object.keys(DEFAULT_ALIASES).join(", ")
      );
    }

    // make sure alias not already taken by another base command
    for (const [b, a] of Object.entries(settings.commandAliases || {})) {
      if (a && a.toLowerCase() === alias && b !== base) {
        return message.reply(
          `.${alias} is already used for base command "${b}". choose another name.`
        );
      }
    }

    settings.commandAliases[base] = alias;
    saveSettings();
    return message.reply(
      `command **${base}** is now triggered by \`.${alias}\``
    );
  }

  // admin command
  if (command === "admin") {
    const sub = args.shift()?.toLowerCase();
    if (!sub) {
      return message.reply(
        "usage: .admin set <user>, .admin category <category>, .admin importantcategory <category>"
      );
    }

    if (sub === "set") {
      const user =
        message.mentions.users.first() ||
        (args[0] && (await client.users.fetch(args[0]).catch(() => null)));
      if (!user) return message.reply("tag a user or give a valid user id.");

      adminSet.add(user.id);
      saveSettings();
      return message.reply(`${user.tag} is now an admin.`);
    }

    if (sub === "category") {
      const mentioned = message.mentions.channels.first();
      let categoryId = null;
      if (mentioned && mentioned.type === ChannelType.GuildCategory) {
        categoryId = mentioned.id;
      } else if (args[0]) {
        const id = args[0].match(/\d{17,20}/);
        if (id) categoryId = id[0];
      }
      if (!categoryId) {
        return message.reply("mention a category or provide a category id.");
      }

      const cat = message.guild.channels.cache.get(categoryId);
      if (!cat || cat.type !== ChannelType.GuildCategory) {
        return message.reply("that id is not a valid category.");
      }

      settings.categoryId = categoryId;
      if (!settings.ticketCategories.includes(categoryId)) {
        settings.ticketCategories.unshift(categoryId);
      }
      saveSettings();

      return message.reply(`ticket category set to ${cat.name}.`);
    }

    if (sub === "importantcategory") {
      const mentioned = message.mentions.channels.first();
      let categoryId = null;
      if (mentioned && mentioned.type === ChannelType.GuildCategory) {
        categoryId = mentioned.id;
      } else if (args[0]) {
        const id = args[0].match(/\d{17,20}/);
        if (id) categoryId = id[0];
      }
      if (!categoryId) {
        return message.reply("mention a category or provide a category id.");
      }

      const cat = message.guild.channels.cache.get(categoryId);
      if (!cat || cat.type !== ChannelType.GuildCategory) {
        return message.reply("that id is not a valid category.");
      }

      settings.importantCategoryId = categoryId;
      saveSettings();

      return message.reply(`important category set to ${cat.name}.`);
    }

    return message.reply("unknown .admin subcommand.");
  }

  // blacklist – block a user from opening tickets via the panel
  if (command === "blacklist") {
    const sub = args[0]?.toLowerCase();

    if (sub === "list") {
      if (!blacklist.size) {
        return message.reply("no users are currently blacklisted.");
      }

      const lines = Array.from(blacklist).map(id => `- <@${id}> (${id})`);
      return message.reply("blacklisted users:\n" + lines.join("\n"));
    }

    const isRemoval = ["remove", "unblacklist", "unblock"].includes(sub);
    if (isRemoval) args.shift();

    const target =
      message.mentions.users.first() ||
      (args[0] && (await client.users.fetch(args[0]).catch(() => null)));

    if (!target) {
      return message.reply("tag a user or give a valid user id.");
    }

    if (isRemoval) {
      if (!blacklist.has(target.id)) {
        return message.reply(`${target.tag} is not blacklisted.`);
      }

      blacklist.delete(target.id);
      saveSettings();
      return message.reply(`${target.tag} has been removed from the blacklist.`);
    }

    if (blacklist.has(target.id)) {
      return message.reply(`${target.tag} is already blacklisted.`);
    }

    blacklist.add(target.id);
    saveSettings();
    return message.reply(
      `${target.tag} has been blacklisted from creating tickets via the panel.`
    );
  }

  // setticketcategory – shortcut for setting main ticket category
  if (command === "setticketcategory") {
    const mentioned = message.mentions.channels.first();
    let categoryId = null;
    if (mentioned && mentioned.type === ChannelType.GuildCategory) {
      categoryId = mentioned.id;
    } else if (args[0]) {
      const id = args[0].match(/\d{17,20}/);
      if (id) categoryId = id[0];
    }
    if (!categoryId) {
      return message.reply("mention a category or provide a category id.");
    }

    const cat = message.guild.channels.cache.get(categoryId);
    if (!cat || cat.type !== ChannelType.GuildCategory) {
      return message.reply("that id is not a valid category.");
    }

    settings.categoryId = categoryId;
    if (!settings.ticketCategories.includes(categoryId)) {
      settings.ticketCategories.unshift(categoryId);
    }
    saveSettings();

    return message.reply(`ticket category set to ${cat.name}.`);
  }

  // setlogs
  if (command === "setlogs") {
    const mentioned = message.mentions.channels.first();
    let logsId = null;

    if (mentioned && mentioned.type === ChannelType.GuildText) {
      logsId = mentioned.id;
    } else if (args[0]) {
      const id = args[0].match(/\d{17,20}/);
      if (id) logsId = id[0];
    }

    if (!logsId) {
      return message.reply("mention a text channel or provide a channel id.");
    }

    const ch = message.guild.channels.cache.get(logsId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      return message.reply("that id is not a valid text channel.");
    }

    settings.logsChannelId = logsId;
    saveSettings();

    return message.reply(`logs channel set to #${ch.name}.`);
  }

  // pingrole
  if (command === "pingrole") {
    const subArg = args[0]?.toLowerCase();

    if (subArg === "clear" || subArg === "none" || subArg === "off") {
      settings.notifyRoleId = null;
      saveSettings();
      return message.reply(
        "ping role cleared. the bot will not ping a staff role automatically."
      );
    }

    const role =
      message.mentions.roles.first() ||
      (args[0] &&
        message.guild.roles.cache.get(
          args[0].match(/\d{17,20}/)?.[0] || ""
        ));
    if (!role) {
      return message.reply(
        "mention a role or provide a role id, or use `.pingrole clear`."
      );
    }

    settings.notifyRoleId = role.id;
    saveSettings();
    return message.reply(`notify role set to @${role.name}.`);
  }

  // ar (autoresponder)
  if (command === "ar") {
    const sub = args.shift()?.toLowerCase();

    if (sub === "list") {
      const autores = settings.autoresponders || {};
      const keys = Object.keys(autores);
      if (!keys.length) return message.reply("no autoresponders are set.");
      const lines = keys.map(k => `- ${k}`);
      return message.reply("current autoresponders:\n" + lines.join("\n"));
    }

    if (sub === "delete") {
      const trigger = args.join(" ").trim().toLowerCase();
      if (!trigger) return message.reply("usage: .ar delete word");
      if (!settings.autoresponders || !settings.autoresponders[trigger]) {
        return message.reply(`no autoresponder found for "${trigger}".`);
      }
      delete settings.autoresponders[trigger];
      saveSettings();
      return message.reply(`autoresponder "${trigger}" deleted.`);
    }

    if (sub === "set") {
      const joined = args.join(" ");
      const splitIndex = joined.indexOf(",");
      if (splitIndex === -1) {
        return message.reply("format: .ar set word, response message");
      }
      const trigger = joined.slice(0, splitIndex).trim().toLowerCase();
      const response = joined.slice(splitIndex + 1).trim();
      if (!trigger || !response) {
        return message.reply(
          "make sure you give both a word and a response. example: .ar set index, send your index with screenshots."
        );
      }
      if (!settings.autoresponders) settings.autoresponders = {};
      settings.autoresponders[trigger] = response;
      saveSettings();
      return message.reply(`autoresponder set for word "${trigger}".`);
    }

    return message.reply(
      "use: .ar set word, response | .ar delete word | .ar list"
    );
  }

  // send – choose which autoresponder is used for auto-send (for sendcategory, not tickets)
  if (command === "send") {
    const trigger = args.join(" ").trim().toLowerCase();
    if (!trigger) return message.reply("usage: .send triggerWord");
    if (!settings.autoresponders || !settings.autoresponders[trigger]) {
      return message.reply(
        `no autoresponder found for "${trigger}". set one first with .ar set.`
      );
    }
    settings.autoSendTrigger = trigger;
    saveSettings();
    return message.reply(
      `auto-send trigger set to "${trigger}". new channels in the sendcategory will send that message automatically.`
    );
  }

  // sendcategory – category for auto-send on new channels
  if (command === "sendcategory") {
    const mentioned = message.mentions.channels.first();
    let categoryId = null;
    if (mentioned && mentioned.type === ChannelType.GuildCategory) {
      categoryId = mentioned.id;
    } else if (args[0]) {
      const id = args[0].match(/\d{17,20}/);
      if (id) categoryId = id[0];
    }
    if (!categoryId) {
      return message.reply("mention a category or provide a category id.");
    }
    const cat = message.guild.channels.cache.get(categoryId);
    if (!cat || cat.type !== ChannelType.GuildCategory) {
      return message.reply("that id is not a valid category.");
    }
    settings.autoSendCategoryId = categoryId;
    saveSettings();
    return message.reply(
      `auto-send category set to ${cat.name}. new text channels under this category will post the .send trigger message.`
    );
  }

  // delayset – delay before autoresponder / auto-send
  if (command === "delayset") {
    if (!args[0]) {
      return message.reply(
        "usage: .delayset 2s  (or .delayset 2 for 2 seconds). 0 = no delay."
      );
    }
    const joined = args[0];
    const match = joined.match(/(\d+(\.\d+)?)/);
    if (!match) {
      return message.reply("give a number of seconds, e.g. .delayset 2");
    }
    const seconds = Number(match[1]);
    if (isNaN(seconds) || seconds < 0) {
      return message.reply("delay must be a non-negative number.");
    }
    settings.autoDelaySeconds = seconds;
    saveSettings();
    return message.reply(
      `delay set to ${seconds} seconds before autoresponder / auto-send messages.`
    );
  }

  // panel – send the ticket panel embed
  if (command === "panel") {
    // optional: set category from arg
    if (args.length > 0) {
      const mentioned = message.mentions.channels.first();
      let categoryId = null;
      if (mentioned && mentioned.type === ChannelType.GuildCategory) {
        categoryId = mentioned.id;
      } else if (args[0]) {
        const id = args[0].match(/\d{17,20}/);
        if (id) categoryId = id[0];
      }
      if (!categoryId) {
        return message.reply("mention a category or provide a category id.");
      }
      const cat = message.guild.channels.cache.get(categoryId);
      if (!cat || cat.type !== ChannelType.GuildCategory) {
        return message.reply("that id is not a valid category.");
      }
      settings.categoryId = categoryId;
      if (!settings.ticketCategories.includes(categoryId)) {
        settings.ticketCategories.unshift(categoryId);
      }
      saveSettings();
    }

    const embed = new EmbedBuilder()
      .setTitle("open ticket for help on indexing brainrots")
      .setDescription(
        "click the button below to open a ticket. please only open a ticket if you actually need help."
      )
      .setColor(0x2b2d31);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_ticket")
        .setLabel("open a ticket")
        .setStyle(ButtonStyle.Primary)
    );

    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }

  // useless – move channel into ticket category
  if (command === "useless") {
    if (!settings.categoryId) {
      return message.reply("ticket category is not configured.");
    }

    const guild = message.guild;
    const category = guild.channels.cache.get(settings.categoryId);

    if (!category || category.type !== ChannelType.GuildCategory) {
      return message.reply("the configured ticket category is invalid.");
    }

    let target = null;

    if (args.length > 0) {
      const mention = message.mentions.channels.first();
      if (mention) {
        target = mention;
      } else {
        const match = args[0].match(/\d{17,20}/);
        if (match) {
          target =
            guild.channels.cache.get(match[0]) ||
            (await guild.channels.fetch(match[0]).catch(() => null));
        }
      }
    }

    if (!target) target = message.channel;

    if (!target || target.type !== ChannelType.GuildText) {
      return message.reply("invalid channel.");
    }

    const oldParent = target.parent;

    try {
      await target.setParent(category.id, { lockPermissions: false });

      const embed = new EmbedBuilder()
        .setTitle("channel moved to ticket category")
        .setColor(0x2b2d31)
        .addFields(
          { name: "channel", value: `<#${target.id}>`, inline: true },
          {
            name: "by",
            value: `${message.author.tag} (${message.author.id})`,
            inline: true
          },
          {
            name: "from",
            value: oldParent ? oldParent.name : "no category",
            inline: false
          },
          { name: "to", value: category.name, inline: false }
        )
        .setTimestamp();

      await logAction(guild, embed);

      try {
        await message.delete();
      } catch {}
    } catch (err) {
      console.error("Move error:", err);
      return message.reply("i could not move that channel.");
    }

    return;
  }

  // important – move channel into important category
  if (command === "important") {
    if (!settings.importantCategoryId) {
      return message.reply("important category is not configured.");
    }

    const guild = message.guild;
    const importantCat =
      guild.channels.cache.get(settings.importantCategoryId);

    if (!importantCat || importantCat.type !== ChannelType.GuildCategory) {
      return message.reply("the configured important category is invalid.");
    }

    let target = null;

    if (args.length > 0) {
      const mention = message.mentions.channels.first();
      if (mention) {
        target = mention;
      } else {
        const match = args[0].match(/\d{17,20}/);
        if (match) {
          target =
            guild.channels.cache.get(match[0]) ||
            (await guild.channels.fetch(match[0]).catch(() => null));
        }
      }
    }

    if (!target) target = message.channel;

    if (!target || target.type !== ChannelType.GuildText) {
      return message.reply("invalid channel.");
    }

    const oldParent = target.parent;

    try {
      await target.setParent(importantCat.id, { lockPermissions: false });

      const embed = new EmbedBuilder()
        .setTitle("channel marked important")
        .setColor(0x2b2d31)
        .addFields(
          { name: "channel", value: `<#${target.id}>`, inline: true },
          {
            name: "by",
            value: `${message.author.tag} (${message.author.id})`,
            inline: true
          },
          {
            name: "from",
            value: oldParent ? oldParent.name : "no category",
            inline: false
          },
          { name: "to", value: importantCat.name, inline: false }
        )
        .setTimestamp();

      await logAction(guild, embed);

      try {
        await message.delete();
      } catch {}
    } catch (err) {
      console.error("Move error (important):", err);
      return message.reply("i could not move that channel to important.");
    }

    return;
  }

  // nuke – clone current channel, delete old channel, say done in new one
  if (command === "nuke") {
    const channel = message.channel;
    const reason = `nuked by ${message.author.tag} (${message.author.id})`;
    const isTicketChannel =
      channel.parentId && settings.ticketCategories.includes(channel.parentId);

    let newChannel;
    try {
      newChannel = await channel.clone({ name: channel.name, reason });
      if (channel.parentId) {
        await newChannel.setParent(channel.parentId, { lockPermissions: false });
      }
      await newChannel.setPosition(channel.position);
    } catch (err) {
      console.error("Nuke clone failed:", err);
      return message.reply("i couldn't clone this channel.");
    }

    const ownerId = ticketOwners.get(channel.id);
    const claimId = ticketClaims.get(channel.id);

    clearTicketState(channel.id);

    if (ownerId) {
      ticketOwners.set(newChannel.id, ownerId);
      activeTickets.set(ownerId, newChannel.id);
    }
    if (claimId) {
      ticketClaims.set(newChannel.id, claimId);
    }

    if (isTicketChannel) {
      await startTicketFlowForChannel(newChannel);
    }

    try {
      await channel.delete(`${reason} via .nuke`);
    } catch (err) {
      console.error("Nuke delete failed:", err);
      await newChannel.send("new channel created, but i couldn't delete the old one.");
      return;
    }

    try {
      await newChannel.send("done");
    } catch (err) {
      console.error("Failed to send nuke confirmation:", err);
    }

    return;
  }

  // done – delete ticket channel (NO blacklist)
  if (command === "done") {
    const channel = message.channel;

    await channel.send("closing channel...");
    await closeTicketChannel(channel, message.author, null);
    return;
  }

  // pingtickets – ping ticket owners in all active tickets
  if (command === "pingtickets") {
    const entries = Array.from(ticketOwners.entries());

    if (!entries.length) {
      return message.reply("there are no active tickets to ping.");
    }

    let pingedCount = 0;

    for (const [channelId, ownerId] of entries) {
      let channel;

      try {
        channel = await message.guild.channels.fetch(channelId);
      } catch {
        continue;
      }

      if (
        !channel ||
        channel.deleted ||
        channel.type !== ChannelType.GuildText ||
        channel.guild.id !== message.guild.id
      ) {
        continue;
      }

      try {
        await channel.send(`<@${ownerId}>`);
        pingedCount++;
      } catch (err) {
        console.error("Failed to ping ticket owner:", err);
      }
    }

    if (pingedCount === 0) {
      return message.reply("no ticket owners could be pinged.");
    }

    const plural = pingedCount === 1 ? "" : "s";
    return message.reply(`pinged ${pingedCount} ticket owner${plural}.`);
  }

  // hi – rename channel from replied message
  if (command === "hi") {
    if (!message.reference) {
      return message.reply(
        "reply to a message and use hi to rename the channel based on that message."
      );
    }

    const ref = await message.fetchReference().catch(() => null);
    if (!ref) return message.reply("could not read the replied message.");

    const sourceText = ref.content || "";
    const fallback = `chan-${message.channel.id.slice(-4)}`;
    const newName = (() => {
      let name = sourceText.toLowerCase();
      name = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      name = name.replace(/[^a-z0-9\s-]/g, " ");
      name = name.trim().replace(/\s+/g, "-");
      if (!name) name = fallback;
      if (name.length > 90) name = name.slice(0, 90);
      return name;
    })();
    const oldName = message.channel.name;

    try {
      await message.channel.setName(newName);

      const embed = new EmbedBuilder()
        .setTitle("channel renamed")
        .setColor(0x2b2d31)
        .addFields(
          { name: "channel", value: `<#${message.channel.id}>`, inline: true },
          {
            name: "by",
            value: `${message.author.tag} (${message.author.id})`,
            inline: true
          },
          { name: "old name", value: oldName, inline: false },
          { name: "new name", value: newName, inline: false },
          {
            name: "from message",
            value: sourceText.slice(0, 200) || "no content"
          }
        )
        .setTimestamp();

      await logAction(message.guild, embed);
    } catch (err) {
      console.error("Rename error:", err);
      return message.reply("i could not rename this channel.");
    }

    try {
      await message.delete();
    } catch {}

    return;
  }

  // help – send paged help embed
  if (command === "help") {
    const page = 1;
    const embed = buildHelpEmbed(page);
    const row = buildHelpRow(page);
    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }
});

// ======================= LOGIN =======================

client.login(TOKEN);
