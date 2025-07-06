exports.smsg = (conn, m, config) => {
  if (!m) return m;
  let M = config.proto.WebMessageInfo;
  m = M.fromObject(m);
  if (m.key) {
    m.id = m.key.id;
    m.device = config.getDevice(m.id);
    m.isBaileys =
      m.id === "web" ||
      m.id.startsWith("3EB0") ||
      m.id.startsWith("BAE5") ||
      m.id.startsWith("B1EY") ||
      m.id.startsWith("AKIRAA-") ||
      false;
    m.chat = conn.decodeJid(
      m.key.remoteJid ||
        message.message?.senderKeyDistributionMessage?.groupId ||
        "",
    );
    m.isGroup = m.chat.endsWith("@g.us");
    m.sender = conn.decodeJid(
      (m.key.fromMe && conn.user.id) ||
        m.participant ||
        m.key.participant ||
        m.chat ||
        "",
    );
    m.fromMe = m.key.fromMe || config.areJidsSameUser(m.sender, conn.user.id);
  }
  if (m.message) {
    let mtype = Object.keys(m.message);
    m.mtype =
      (!["senderKeyDistributionMessage", "messageContextInfo"].includes(
        mtype[0],
      ) &&
        mtype[0]) || // Sometimes message in the front
      (mtype.length >= 3 && mtype[1] !== "messageContextInfo" && mtype[1]) || // Sometimes message in midle if mtype length is greater than or equal to 3!
      mtype[mtype.length - 1]; // common case
    m.msg = m.message[m.mtype];
    if (
      m.chat == "status@broadcast" &&
      ["protocolMessage", "senderKeyDistributionMessage"].includes(m.mtype)
    )
      m.chat =
        (m.key.remoteJid !== "status@broadcast" && m.key.remoteJid) || m.sender;
    if (m.mtype == "protocolMessage" && m.msg.key) {
      if (m.msg.key.remoteJid == "status@broadcast")
        m.msg.key.remoteJid = m.chat;
      if (!m.msg.key.participant || m.msg.key.participant == "status_me")
        m.msg.key.participant = m.sender;
      m.msg.key.fromMe =
        conn.decodeJid(m.msg.key.participant) === conn.decodeJid(conn.user.id);
      if (
        !m.msg.key.fromMe &&
        m.msg.key.remoteJid === conn.decodeJid(conn.user.id)
      )
        m.msg.key.remoteJid = m.sender;
    }
    m.text = m.msg.text || m.msg.caption || m.msg.contentText || m.msg || "";
    if (typeof m.text !== "string") {
      if (
        [
          "protocolMessage",
          "messageContextInfo",
          "stickerMessage",
          "audioMessage",
          "senderKeyDistributionMessage",
        ].includes(m.mtype)
      )
        m.text = "";
      else
        m.text =
          m.text.selectedDisplayText ||
          m.text.hydratedTemplate?.hydratedContentText ||
          m.text;
    }
    m.mentionedJid =
      (m.msg?.contextInfo?.mentionedJid?.length &&
        m.msg.contextInfo.mentionedJid) ||
      [];
    let quoted = (m.quoted = m.msg?.contextInfo?.quotedMessage
      ? m.msg.contextInfo.quotedMessage
      : null);
    if (m.quoted) {
      let type = Object.keys(m.quoted)[0];
      m.quoted = m.quoted[type];
      if (typeof m.quoted === "string") m.quoted = { text: m.quoted };
      m.quoted.mtype = type;
      m.quoted.id = m.msg.contextInfo.stanzaId;
      m.quoted.device = config.getDevice(m.quoted.id);
      m.quoted.chat = conn.decodeJid(
        m.msg.contextInfo.remoteJid || m.chat || m.sender,
      );
      m.quoted.isBaileys =
        m.quoted.device === "web" ||
        m.id.startsWith("3EB0") ||
        m.id.startsWith("BAE5") ||
        m.id.startsWith("AKIRAA") ||
        false;
      m.quoted.sender = conn.decodeJid(m.msg.contextInfo.participant);
      m.quoted.fromMe = m.quoted.sender === conn.user.jid;
      m.quoted.text =
        m.quoted.text || m.quoted.caption || m.quoted.contentText || "";
      m.quoted.name = conn.getName(m.quoted.sender);
      m.quoted.mentionedJid =
        (m.quoted.contextInfo?.mentionedJid?.length &&
          m.quoted.contextInfo.mentionedJid) ||
        [];
      let vM = (m.quoted.fakeObj = M.fromObject({
        key: {
          fromMe: m.quoted.fromMe,
          remoteJid: m.quoted.chat,
          id: m.quoted.id,
        },
        message: quoted,
        ...(m.isGroup ? { participant: m.quoted.sender } : {}),
      }));
      m.getQuotedObj = m.getQuotedMessage = async () => {
        if (!m.quoted.id) return null;
        let q = M.fromObject((await conn.loadMessage(m.quoted.id)) || vM);
        return exports.smsg(conn, q);
      };
      if (m.quoted.url || m.quoted.directPath)
        m.quoted.download = (saveToFile = false) =>
          conn.downloadM(
            m.quoted,
            m.quoted.mtype.replace(/message/i, ""),
            saveToFile,
          );
      m.quoted.reply = (text, chatId, options) =>
        conn.reply(chatId ? chatId : m.chat, text, vM, options);
      m.quoted.copy = () => exports.smsg(conn, M.fromObject(M.toObject(vM)));
      m.quoted.forward = (jid, forceForward = false) =>
        conn.forwardMessage(jid, vM, forceForward);

      m.quoted.copyNForward = (jid, forceForward = true, options = {}) =>
        conn.copyNForward(jid, vM, forceForward, options);
      m.quoted.cMod = (
        jid,
        text = "",
        sender = m.quoted.sender,
        options = {},
      ) => conn.cMod(jid, vM, text, sender, options);

      m.quoted.delete = () =>
        conn.sendMessage(m.quoted.chat, { delete: vM.key });
    }
  }
  m.name = m.pushName || conn.getName(m.sender);
  if (m.msg && m.msg.url)
    m.download = (saveToFile = false) =>
      conn.downloadM(m.msg, m.mtype.replace(/message/i, ""), saveToFile);

  m.copy = () => exports.smsg(conn, M.fromObject(M.toObject(m)));

  m.forward = (jid = m.chat, forceForward = false) =>
    conn.copyNForward(jid, m, forceForward, options);
  m.react = async(emot) => {
    await conn.sendMessage(m.chat, {
      react: {
        text: emot,
        key: m.key
      }
   })
  }
  m.reply = async (pesan, options) => {
    const a = {
      contextInfo: {
        mentionedJid: conn.parseMention(pesan)
      },
    };
    try {
      if (options && pesan) {
        conn.sendFile(m.chat, options, null, pesan, m, null, a);
      } else {
        if (pesan) {
          conn.reply(m.chat, pesan, m, a);
        } else {
          conn.reply(m.chat, options, m, a);
        }
      }
    } catch (e) {
      conn.reply(m.chat, pesan, m, a);
    }
  };
  m.copyNForward = (jid = m.chat, forceForward = true, options = {}) =>
    conn.copyNForward(jid, m, forceForward, options);
  m.cMod = (jid, text = "", sender = m.sender, options = {}) =>
    conn.cMod(jid, m, text, sender, options);
  m.delete = () => conn.sendMessage(m.chat, { delete: m.key });
  try {
    if (m.msg && m.mtype == "protocolMessage")
      conn.ev.emit("message.delete", m.msg.key);
  } catch (e) {
    console.error(e);
  }
  return m;
};