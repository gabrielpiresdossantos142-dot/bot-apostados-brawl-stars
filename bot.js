require("./server");

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  AttachmentBuilder,
} = require("discord.js");

const QRCode = require("qrcode");
require("dotenv").config();

const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID || null,
  ADMIN_ROLE_IDS: process.env.ADMIN_ROLE_IDS
    ? process.env.ADMIN_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
    : [],
  TICKET_PREFIX: "aposta-",
  CANAL_APOSTAS_ID: process.env.CANAL_APOSTAS_ID || null,
  PIX_CHAVE: process.env.PIX_CHAVE || null,
  PIX_NOME: process.env.PIX_NOME || "Bot Apostados",
  PIX_CIDADE: process.env.PIX_CIDADE || "Brasil",
};

const MODOS_DE_JOGO = {
  futebrawl:       { nome: "Futebrawl ⚽",        emoji: "⚽" },
  piquegema:       { nome: "Pique-Gema 💎",       emoji: "💎" },
  exterminio:      { nome: "Extermínio 💀",       emoji: "💀" },
  zonaestrategica: { nome: "Zona Estratégica 🔥", emoji: "🔥" },
  roubo:           { nome: "Roubo 💰",            emoji: "💰" },
  nocaute:         { nome: "Nocaute 🥊",          emoji: "🥊" },
  duelos:          { nome: "Duelos 🤺",           emoji: "🤺" },
  cacaestelar:     { nome: "Caça Estelar ⭐",     emoji: "⭐" },
};

const apostasAtivas = new Map();

function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");
}

function emvField(id, value) {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

function gerarPayloadPix(chave, nome, cidade, valor) {
  const nomeClean = nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 25);
  const cidadeClean = cidade.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 15);
  const merchantInfo = emvField("00", "br.gov.bcb.pix") + emvField("01", chave);
  let payload = "";
  payload += emvField("00", "01");
  payload += emvField("26", merchantInfo);
  payload += emvField("52", "0000");
  payload += emvField("53", "986");
  if (valor) payload += emvField("54", valor.toFixed(2));
  payload += emvField("58", "BR");
  payload += emvField("59", nomeClean);
  payload += emvField("60", cidadeClean);
  payload += emvField("62", emvField("05", "***"));
  payload += "6304";
  payload += crc16(payload);
  return payload;
}

async function gerarQRCodeBuffer(texto) {
  return QRCode.toBuffer(texto, { errorCorrectionLevel: "M", width: 300, margin: 2 });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registrarComandos() {
  const modoChoices = Object.entries(MODOS_DE_JOGO).map(([key, val]) => ({ name: val.nome, value: key }));
  const comando = new SlashCommandBuilder()
    .setName("apostados")
    .setDescription("Criar uma aposta de Brawl Stars")
    .addNumberOption((opt) => opt.setName("valor").setDescription("Valor da aposta em reais (R$)").setRequired(true).setMinValue(0.01))
    .addStringOption((opt) => opt.setName("modo").setDescription("Modo de jogo").setRequired(true).addChoices(...modoChoices))
    .addStringOption((opt) => opt.setName("descricao").setDescription("Informações extras").setRequired(false));
  const rest = new REST({ version: "10" }).setToken(CONFIG.TOKEN);
  try {
    if (CONFIG.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: [comando.toJSON()] });
      console.log(`✅ Comandos registrados no servidor ${CONFIG.GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: [comando.toJSON()] });
      console.log("✅ Comandos registrados globalmente");
    }
  } catch (err) {
    console.error("❌ Erro ao registrar comandos:", err.message);
  }
}

function formatarReais(valor) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function isAdmin(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    CONFIG.ADMIN_ROLE_IDS.some((r) => member.roles.cache.has(r));
}

function criarEmbedAposta(user, valor, modo, descricao, status) {
  const cores = { aguardando: 0xf59e0b, aceita: 0x22c55e, cancelada: 0xef4444, encerrada: 0x6b7280 };
  const statusTexto = { aguardando: "⏳ Aguardando adversário", aceita: "✅ Aposta Aceita — Ticket Aberto", cancelada: "❌ Cancelada", encerrada: "🏁 Encerrada" };
  const embed = new EmbedBuilder()
    .setTitle(`${modo.emoji} Aposta de Brawl Stars — ${modo.nome}`)
    .setColor(cores[status] || 0xf59e0b)
    .addFields(
      { name: "💰 Valor", value: formatarReais(valor), inline: true },
      { name: "🎮 Modo", value: modo.nome, inline: true },
      { name: "👤 Apostador", value: `<@${user.id}>`, inline: true },
      { name: "📊 Status", value: statusTexto[status], inline: false }
    )
    .setThumbnail(user.displayAvatarURL({ dynamic: true }))
    .setTimestamp()
    .setFooter({ text: "Bot Apostados Brawl Stars 🎮" });
  if (descricao) embed.addFields({ name: "📝 Detalhes", value: descricao, inline: false });
  return embed;
}

client.once("ready", async () => {
  console.log(`\n🤖 Bot conectado como: ${client.user.tag}`);
  client.user.setActivity("Brawl Stars 🎮", { type: 0 });
  try {
    await client.application.edit({
      description: `Se você acha que é bom no Brawl Stars, prova isso valendo dinheiro 💰\n⚔️ 1v1 • Nocaute • Futebrawl\n💸 Aposte e ganhe de verdade\n🚀 Sistema rápido e seguro\n\nEntra aí : 👇\nhttps://discord.gg/gs27xYdURs`,
    });
    console.log("✅ Biografia atualizada!");
  } catch (err) {
    console.error("❌ Erro ao atualizar biografia:", err.message);
  }
  await registrarComandos();
  console.log("\n✅ Bot pronto e funcionando!\n");
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "apostados") {
      await handleComandoApostados(interaction); return;
    }
    if (interaction.isButton()) {
      const parts = interaction.customId.split(":");
      const acao = parts[0], apostaId = parts[1];
      if (acao === "aceitar") await handleAceitarAposta(interaction, apostaId);
      else if (acao === "cancelar") await handleCancelarAposta(interaction, apostaId);
      else if (acao === "fechar_ticket") await handleFecharTicket(interaction);
      else if (acao === "resultado") await handleResultado(interaction, apostaId);
      else if (acao === "confirmar_resultado") await handleConfirmarResultado(interaction, apostaId, parts[2]);
      else if (acao === "disputar_resultado") await handleDisputarResultado(interaction, apostaId);
    }
  } catch (err) {
    console.error("Erro:", err);
    try {
      const msg = { content: "❌ Erro interno. Tente novamente.", ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

async function handleComandoApostados(interaction) {
  if (CONFIG.CANAL_APOSTAS_ID && interaction.channelId !== CONFIG.CANAL_APOSTAS_ID)
    return interaction.reply({ content: `❌ Use este comando no canal <#${CONFIG.CANAL_APOSTAS_ID}>.`, ephemeral: true });
  await interaction.deferReply();
  const valor = interaction.options.getNumber("valor");
  const modoKey = interaction.options.getString("modo");
  const descricao = interaction.options.getString("descricao") || null;
  const user = interaction.user;
  const modo = MODOS_DE_JOGO[modoKey];
  if (!modo) return interaction.editReply({ content: "❌ Modo inválido." });
  const apostaId = `${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`aceitar:${apostaId}`).setLabel("✅  Aceitar Aposta").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancelar:${apostaId}`).setLabel("❌  Cancelar").setStyle(ButtonStyle.Danger)
  );
  const mensagem = await interaction.editReply({
    content: `🏆 **Nova aposta!** <@${user.id}> quer apostar ${formatarReais(valor)} no modo **${modo.nome}**! Alguém topa?`,
    embeds: [criarEmbedAposta(user, valor, modo, descricao, "aguardando")],
    components: [row],
  });
  apostasAtivas.set(apostaId, { apostadorId: user.id, apostadorTag: user.username, valor, modo, descricao, mensagemId: mensagem.id, canalId: interaction.channelId, guildId: interaction.guildId, criadaEm: Date.now(), status: "aguardando" });
  setTimeout(async () => {
    const aposta = apostasAtivas.get(apostaId);
    if (aposta && aposta.status === "aguardando") {
      aposta.status = "encerrada";
      try {
        const canal = await client.channels.fetch(aposta.canalId);
        const msg = await canal.messages.fetch(aposta.mensagemId);
        const fakeUser = { id: aposta.apostadorId, username: aposta.apostadorTag, displayAvatarURL: () => null };
        await msg.edit({ content: "⏰ Aposta expirada (24h).", embeds: [criarEmbedAposta(fakeUser, aposta.valor, aposta.modo, aposta.descricao, "encerrada")], components: [] });
      } catch (_) {}
      apostasAtivas.delete(apostaId);
    }
  }, 24 * 60 * 60 * 1000);
}

async function handleAceitarAposta(interaction, apostaId) {
  await interaction.deferReply({ ephemeral: true });
  const aposta = apostasAtivas.get(apostaId);
  if (!aposta) return interaction.editReply({ content: "❌ Aposta não encontrada ou expirada." });
  if (aposta.status !== "aguardando") return interaction.editReply({ content: "❌ Aposta já aceita ou cancelada." });
  if (interaction.user.id === aposta.apostadorId) return interaction.editReply({ content: "❌ Você não pode aceitar sua própria aposta!" });
  aposta.status = "aceita";
  aposta.adversarioId = interaction.user.id;
  aposta.adversarioTag = interaction.user.username;
  const guild = interaction.guild;
  const adversario = interaction.member;
  const permissoes = [
    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: aposta.apostadorId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: adversario.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
  ];
  for (const roleId of CONFIG.ADMIN_ROLE_IDS) {
    permissoes.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.ReadMessageHistory] });
  }
  const nomeApost = aposta.apostadorTag.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "jogador1";
  const nomeAdv = adversario.user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "jogador2";
  let nomeCanal = `${CONFIG.TICKET_PREFIX}${nomeApost}-vs-${nomeAdv}`;
  if (nomeCanal.length > 100) nomeCanal = nomeCanal.slice(0, 100);
  const opcoesCriar = { name: nomeCanal, type: ChannelType.GuildText, permissionOverwrites: permissoes, topic: `Aposta: ${aposta.modo.nome} | ${formatarReais(aposta.valor)} | @${aposta.apostadorTag} vs @${adversario.user.username}` };
  if (CONFIG.TICKET_CATEGORY_ID) opcoesCriar.parent = CONFIG.TICKET_CATEGORY_ID;
  let ticketCanal;
  try {
    ticketCanal = await guild.channels.create(opcoesCriar);
  } catch (err) {
    console.error("Erro ao criar ticket:", err);
    aposta.status = "aguardando";
    return interaction.editReply({ content: "❌ Não foi possível criar o ticket. Verifique as permissões do bot." });
  }
  aposta.ticketCanalId = ticketCanal.id;
  const embedTicket = new EmbedBuilder()
    .setTitle(`${aposta.modo.emoji} Ticket de Aposta — ${aposta.modo.nome}`)
    .setColor(0x22c55e)
    .addFields(
      { name: "👤 Apostador", value: `<@${aposta.apostadorId}>`, inline: true },
      { name: "🆚 Adversário", value: `<@${adversario.id}>`, inline: true },
      { name: "💰 Valor", value: formatarReais(aposta.valor), inline: true },
      { name: "🎮 Modo", value: aposta.modo.nome, inline: true },
      { name: "📋 Como funciona", value: "1️⃣ Combinem horário e servidor.\n2️⃣ Após o jogo, clique em **Eu ganhei!** e envie o print.\n3️⃣ Um árbitro confirma e fecha o ticket.", inline: false }
    )
    .setTimestamp()
    .setFooter({ text: "Bot Apostados Brawl Stars 🎮" });
  if (aposta.descricao) embedTicket.addFields({ name: "📝 Detalhes", value: aposta.descricao, inline: false });
  const rowTicket = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`resultado:${apostaId}:apostador`).setLabel("🏆 Eu ganhei! (Apostador)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`resultado:${apostaId}:adversario`).setLabel("🏆 Eu ganhei! (Adversário)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`fechar_ticket:${apostaId}`).setLabel("🔒 Fechar Ticket").setStyle(ButtonStyle.Secondary)
  );
  const mencoes = [`<@${aposta.apostadorId}>`, `<@${adversario.id}>`, ...CONFIG.ADMIN_ROLE_IDS.map((r) => `<@&${r}>`)].join(" ");
  await ticketCanal.send({ content: mencoes, embeds: [embedTicket], components: [rowTicket] });

  if (CONFIG.PIX_CHAVE) {
    try {
      const path = require("path");
      const fs = require("fs");
      const staticQR = path.join(__dirname, "pix-qrcode.png");
      const temQRestatico = fs.existsSync(staticQR);
      let anexo;
      if (temQRestatico) {
        anexo = new AttachmentBuilder(staticQR, { name: "pix-qrcode.png" });
      } else {
        const payload = gerarPayloadPix(CONFIG.PIX_CHAVE, CONFIG.PIX_NOME, CONFIG.PIX_CIDADE, aposta.valor);
        const qrBuffer = await gerarQRCodeBuffer(payload);
        anexo = new AttachmentBuilder(qrBuffer, { name: "pix-qrcode.png" });
      }
      const embedPix = new EmbedBuilder()
        .setTitle("💸 Pagamento via PIX")
        .setColor(0x22c55e)
        .setDescription("Ambos os jogadores devem enviar o valor antes de começar.")
        .addFields(
          { name: "💰 Valor a pagar (cada um)", value: formatarReais(aposta.valor), inline: false },
          { name: "🔑 Chave PIX (Copia e Cola)", value: `\`${CONFIG.PIX_CHAVE}\``, inline: false }
        )
        .setImage("attachment://pix-qrcode.png")
        .setFooter({ text: "Escaneie o QR Code ou copie a chave PIX no seu banco 💳" });
      await ticketCanal.send({ embeds: [embedPix], files: [anexo] });
    } catch (err) {
      console.error("Erro ao enviar PIX:", err.message);
      await ticketCanal.send({
        embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("💸 Pagamento via PIX").addFields({ name: "🔑 Chave PIX", value: CONFIG.PIX_CHAVE }, { name: "💰 Valor", value: formatarReais(aposta.valor) })],
      });
    }
  }

  try {
    const canalOriginal = await client.channels.fetch(aposta.canalId);
    const msgOriginal = await canalOriginal.messages.fetch(aposta.mensagemId);
    const fakeUser = { id: aposta.apostadorId, username: aposta.apostadorTag, displayAvatarURL: () => null };
    await msgOriginal.edit({ content: `✅ Aposta aceita por <@${adversario.id}>! Ticket: ${ticketCanal}`, embeds: [criarEmbedAposta(fakeUser, aposta.valor, aposta.modo, aposta.descricao, "aceita")], components: [] });
  } catch (_) {}
  await interaction.editReply({ content: `✅ Você aceitou! Ticket criado em ${ticketCanal}.` });
}

async function handleCancelarAposta(interaction, apostaId) {
  await interaction.deferReply({ ephemeral: true });
  const aposta = apostasAtivas.get(apostaId);
  if (!aposta) return interaction.editReply({ content: "❌ Aposta não encontrada." });
  if (interaction.user.id !== aposta.apostadorId && !isAdmin(interaction.member))
    return interaction.editReply({ content: "❌ Somente o apostador ou admin pode cancelar." });
  if (aposta.status !== "aguardando") return interaction.editReply({ content: "❌ Só é possível cancelar apostas aguardando." });
  aposta.status = "cancelada";
  try {
    const fakeUser = { id: aposta.apostadorId, username: aposta.apostadorTag, displayAvatarURL: () => null };
    const canal = await client.channels.fetch(aposta.canalId);
    const msg = await canal.messages.fetch(aposta.mensagemId);
    await msg.edit({ content: "❌ Aposta cancelada.", embeds: [criarEmbedAposta(fakeUser, aposta.valor, aposta.modo, aposta.descricao, "cancelada")], components: [] });
  } catch (_) {}
  apostasAtivas.delete(apostaId);
  await interaction.editReply({ content: "✅ Aposta cancelada." });
}

async function handleResultado(interaction, apostaId) {
  await interaction.deferReply({ ephemeral: false });
  const aposta = apostasAtivas.get(apostaId);
  if (!aposta) return interaction.editReply({ content: "❌ Dados não encontrados." });
  const participa = interaction.user.id === aposta.apostadorId || interaction.user.id === aposta.adversarioId;
  if (!participa && !isAdmin(interaction.member)) return interaction.editReply({ content: "❌ Somente participantes ou admins." });
  const lado = interaction.customId.split(":")[2];
  const vencedorId = lado === "apostador" ? aposta.apostadorId : aposta.adversarioId;
  const rowResultado = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirmar_resultado:${apostaId}:${vencedorId}`).setLabel("✅ Confirmar (Árbitro)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`disputar_resultado:${apostaId}`).setLabel("⚠️ Disputar (Árbitro)").setStyle(ButtonStyle.Danger)
  );
  await interaction.editReply({
    embeds: [new EmbedBuilder().setTitle("🏆 Resultado Declarado").setColor(0xf59e0b).setDescription("⚠️ Aguardando confirmação do árbitro. Envie o print.").addFields({ name: "Declarado por", value: `<@${interaction.user.id}>`, inline: true }, { name: "Vencedor alegado", value: `<@${vencedorId}>`, inline: true }, { name: "Valor", value: formatarReais(aposta.valor), inline: true }).setTimestamp()],
    components: [rowResultado],
  });
}

async function handleConfirmarResultado(interaction, apostaId, vencedorId) {
  await interaction.deferReply({ ephemeral: false });
  if (!isAdmin(interaction.member)) return interaction.editReply({ content: "❌ Somente árbitros podem confirmar." });
  const aposta = apostasAtivas.get(apostaId);
  await interaction.editReply({
    embeds: [new EmbedBuilder().setTitle("🏆 Resultado Confirmado!").setColor(0x22c55e).addFields({ name: "🥇 Vencedor", value: `<@${vencedorId}>`, inline: true }, { name: "💰 Prêmio", value: aposta ? formatarReais(aposta.valor) : "—", inline: true }, { name: "✅ Confirmado por", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp()],
    components: [],
  });
  if (aposta) { aposta.status = "encerrada"; apostasAtivas.delete(apostaId); }
  setTimeout(async () => {
    try {
      await interaction.channel.send("🔒 Fechando ticket em instantes...");
      setTimeout(async () => { try { await interaction.channel.delete("Aposta encerrada"); } catch (_) {} }, 5000);
    } catch (_) {}
  }, 60000);
}

async function handleDisputarResultado(interaction, apostaId) {
  await interaction.deferReply({ ephemeral: false });
  if (!isAdmin(interaction.member)) return interaction.editReply({ content: "❌ Somente árbitros podem disputar." });
  await interaction.editReply({ content: `⚠️ **Resultado em disputa!** <@${interaction.user.id}> sinalizou inconsistência. Analise os prints manualmente.`, components: [] });
}

async function handleFecharTicket(interaction) {
  await interaction.deferReply({ ephemeral: true });
  if (!isAdmin(interaction.member)) return interaction.editReply({ content: "❌ Somente admins podem fechar o ticket." });
  await interaction.editReply({ content: "✅ Fechando em 5 segundos..." });
  setTimeout(async () => { try { await interaction.channel.delete("Ticket fechado por admin"); } catch (err) { console.error(err); } }, 5000);
}

client.on("error", (err) => console.error("❌ Erro:", err));
process.on("unhandledRejection", (reason) => console.error("❌ Erro não tratado:", reason));

if (!CONFIG.TOKEN) { console.error("❌ DISCORD_TOKEN não configurado."); process.exit(1); }
if (!CONFIG.CLIENT_ID) { console.error("❌ CLIENT_ID não configurado."); process.exit(1); }

client.login(CONFIG.TOKEN).catch((err) => { console.error("❌ Falha ao conectar:", err.message); process.exit(1); });
