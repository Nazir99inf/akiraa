
const { toAudio, toPTT, toVideo } = require("./converter");
const chalk = require("chalk");
const fetch = require("node-fetch");
const FileType = require("file-type");
const PhoneNumber = require("awesome-phonenumber");
const fs = require("fs");
const path = require("path");
let Jimp = require("jimp");
const pino = require("pino");
const {
  imageToWebp,
  videoToWebp,
  writeExifImg,
  writeExifVid,
} = require("./exif");
global.ephemeral = { ephemeralExpiration: 86400 };

exports.makeWASocket = (connectionOptions, config) => {
  let conn = config.makeWASocket(
    connectionOptions,
  );
  conn.loadAllMessages = (messageID) => {
    return Object.entries(conn.chats)
      .filter(([_, { messages }]) => typeof messages === "object")
      .find(([_, { messages }]) =>
        Object.entries(messages).find(
          ([k, v]) => k === messageID || v.key?.id === messageID,
        ),
      )?.[1].messages?.[messageID];
  };
  /* conn.groupMetadata = (jid) => {
    return store.groupMetadata[jid]
    }*/
  conn.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      const decode = config.jidDecode(jid) || {};
      return (
        (decode.user && decode.server && decode.user + "@" + decode.server) ||
        jid
      );
    } else return jid;
  };
  if (conn.user && conn.user.id) conn.user.jid = conn.decodeJid(conn.user.id);
  if (!conn.chats) conn.chats = {};

  function updateNameToDb(contacts) {
    if (!contacts) return;
    for (const contact of contacts) {
      const id = conn.decodeJid(contact.id);
      if (!id) continue;
      let chats = conn.chats[id];
      if (!chats) chats = conn.chats[id] = { id };
      conn.chats[id] = {
        ...chats,
        ...({
          ...contact,
          id,
          ...(id.endsWith("@g.us")
            ? { subject: contact.subject || chats.subject || "" }
            : { name: contact.notify || chats.name || chats.notify || "" }),
        } || {}),
      };
    }
  }

  conn.ev.on("contacts.upsert", updateNameToDb);
  conn.ev.on("groups.update", updateNameToDb);
  conn.ev.on("chats.set", async ({ chats }) => {
    for (const { id, name, readOnly } of chats) {
      id = conn.decodeJid(id);
      if (!id) continue;
      const isGroup = id.endsWith("@g.us");
      let chats = conn.chats[id];
      if (!chats) chats = conn.chats[id] = { id };
      chats.isChats = !readOnly;
      if (name) chats[isGroup ? "subject" : "name"] = name;
      if (isGroup) {
        const metadata = await conn.groupMetadata(id).catch((_) => null);
        if (!metadata) continue;
        chats.subject = name || metadata.subject;
        chats.metadata = metadata;
      }
    }
  });
  conn.ev.on(
    "group-participants.update",
    async function updateParticipantsToDb({ id, participants, action }) {
      id = conn.decodeJid(id);
      if (!(id in conn.chats)) conn.chats[id] = { id };
      conn.chats[id].isChats = true;
      const groupMetadata = await conn.groupMetadata(id).catch((_) => null);
      if (!groupMetadata) return;
      conn.chats[id] = {
        ...conn.chats[id],
        subject: groupMetadata.subject,
        metadata: groupMetadata,
      };
    },
  );

  conn.ev.on(
    "groups.update",
    async function groupUpdatePushToDb(groupsUpdates) {
      for (const update of groupsUpdates) {
        const id = conn.decodeJid(update.id);
        if (!id) continue;
        const isGroup = id.endsWith("@g.us");
        if (!isGroup) continue;
        let chats = conn.chats[id];
        if (!chats) chats = conn.chats[id] = { id };
        chats.isChats = true;
        const metadata = await conn.groupMetadata(id).catch((_) => null);
        if (!metadata) continue;
        chats.subject = metadata.subject;
        chats.metadata = metadata;
      }
    },
  );
  conn.ev.on("chats.upsert", async function chatsUpsertPushToDb(chatsUpsert) {
    console.log({ chatsUpsert });
    const { id, name } = chatsUpsert;
    if (!id) return;
    let chats = (conn.chats[id] = {
      ...conn.chats[id],
      ...chatsUpsert,
      isChats: true,
    });
    const isGroup = id.endsWith("@g.us");
    if (isGroup) {
      const metadata = await conn.groupMetadata(id).catch((_) => null);
      if (metadata) {
        chats.subject = name || metadata.subject;
        chats.metadata = metadata;
      }
      const groups =
        (await conn.groupFetchAllParticipating().catch((_) => ({}))) || {};
      for (const group in groups)
        conn.chats[group] = {
          id: group,
          subject: groups[group].subject,
          isChats: true,
          metadata: groups[group],
        };
    }
  });
  conn.ev.on(
    "presence.update",
    async function presenceUpdatePushToDb({ id, presences }) {
      const sender = Object.keys(presences)[0] || id;
      const _sender = conn.decodeJid(sender);
      const presence = presences[sender]["lastKnownPresence"] || "composing";
      let chats = conn.chats[_sender];
      if (!chats) chats = conn.chats[_sender] = { id: sender };
      chats.presences = presence;
      if (id.endsWith("@g.us")) {
        let chats = conn.chats[id];
        if (!chats) {
          const metadata = await conn.groupMetadata(id).catch((_) => null);
          if (metadata)
            chats = conn.chats[id] = {
              id,
              subject: metadata.subject,
              metadata,
            };
        }
        chats.isChats = true;
      }
    },
  );

  conn.logger = {
    ...conn.logger,
    info(...args) {
      console.log(
        chalk.bold.rgb(
          57,
          183,
          16,
        )(`INFO [${chalk.rgb(255, 255, 255)(new Date())}]:`),
        chalk.cyan(...args),
      );
    },
    error(...args) {
      console.log(
        chalk.bold.rgb(
          247,
          38,
          33,
        )(`ERROR [${chalk.rgb(255, 255, 255)(new Date())}]:`),
        chalk.rgb(255, 38, 0)(...args),
      );
    },
    warn(...args) {
      console.log(
        chalk.bold.rgb(
          239,
          225,
          3,
        )(`WARNING [${chalk.rgb(255, 255, 255)(new Date())}]:`),
        chalk.keyword("orange")(...args),
      );
    },
  };

  conn.appendTextMessage = async (m, text, chatUpdate) => {
    let messages = await generateWAMessage(
      m.chat,
      {
        text: text,
        mentions: m.mentionedJid,
      },
      {
        userJid: conn.user.id,
        quoted: m.quoted && m.quoted.fakeObj,
        ...ephemeral,
      },
    );
    messages.key.fromMe = config.areJidsSameUser(m.sender, conn.user.id);
    messages.key.id = m.key.id;
    messages.pushName = m.pushName;
    if (m.isGroup) messages.participant = m.sender;
    let msg = {
      ...chatUpdate,
      messages: [config.getDevice.WebMessageInfo.fromObject(messages)],
      type: "append",
    };
    conn.ev.emit("messages.upsert", msg);
    return m;
  };

  /**
   * getBuffer hehe
   * @param {fs.PathLike} path
   * @param {Boolean} returnFilename
   */
  conn.getFile = async (PATH, returnAsFilename) => {
    let res, filename;
    const data = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? await (res = await fetch(PATH)).buffer()
          : fs.existsSync(PATH)
            ? ((filename = PATH), fs.readFileSync(PATH))
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);
    if (!Buffer.isBuffer(data)) throw new TypeError("Result is not a buffer");
    const type = (await FileType.fromBuffer(data)) || {
      mime: "application/octet-stream",
      ext: ".bin",
    };
    if (data && returnAsFilename && !filename)
      (filename = path.join(
        __dirname,
        "../tmp/" + new Date() * 1 + "." + type.ext,
      )),
        await fs.promises.writeFile(filename, data);
    return {
      res,
      filename,
      ...type,
      data,
      deleteFile() {
        return filename && fs.promises.unlink(filename);
      },
    };
  };

  /**
   * waitEvent
   * @param {Partial<BaileysEventMap>|String} eventName
   * @param {Boolean} is
   * @param {Number} maxTries
   * @returns
   */
  conn.waitEvent = (eventName, is = () => true, maxTries = 25) => {
    return new Promise((resolve, reject) => {
      let tries = 0;
      let on = (...args) => {
        if (++tries > maxTries) reject("Max tries reached");
        else if (is()) {
          conn.ev.off(eventName, on);
          resolve(...args);
        }
      };
      conn.ev.on(eventName, on);
    });
  };

  conn.delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   *
   * @param {String} text
   * @returns
   */
  conn.filter = (text) => {
    let mati = [
      "q",
      "w",
      "r",
      "t",
      "y",
      "p",
      "s",
      "d",
      "f",
      "g",
      "h",
      "j",
      "k",
      "l",
      "z",
      "x",
      "c",
      "v",
      "b",
      "n",
      "m",
    ];
    if (/[aiueo][aiueo]([qwrtypsdfghjklzxcvbnm])?$/i.test(text))
      return text.substring(text.length - 1);
    else {
      let res = Array.from(text).filter((v) => mati.includes(v));
      let resu = res[res.length - 1];
      for (let huruf of mati) {
        if (text.endsWith(huruf)) {
          resu = res[res.length - 2];
        }
      }
      let misah = text.split(resu);
      return resu + misah[misah.length - 1];
    }
  };

  /**
   * ms to date
   * @param {String} ms
   */
  conn.msToDate = (ms) => {
    let days = Math.floor(ms / (24 * 60 * 60 * 1000));
    let daysms = ms % (24 * 60 * 60 * 1000);
    let hours = Math.floor(daysms / (60 * 60 * 1000));
    let hoursms = ms % (60 * 60 * 1000);
    let minutes = Math.floor(hoursms / (60 * 1000));
    let minutesms = ms % (60 * 1000);
    let sec = Math.floor(minutesms / 1000);
    return days + " Hari " + hours + " Jam " + minutes + " Menit";
    // +minutes+":"+sec;
  };

  /**
   * isi
   */
  conn.rand = async (isi) => {
    return isi[Math.floor(Math.random() * isi.length)];
  };

  /**
   * Send Media All Type
   * @param {String} jid
   * @param {String|Buffer} path
   * @param {Object} quoted
   * @param {Object} options
   */
  conn.sendMedia = async (jid, path, quoted, options = {}) => {
    let { ext, mime, data } = await conn.getFile(path);
    messageType = mime.split("/")[0];
    pase = messageType.replace("application", "document") || messageType;
    return await conn.sendMessage(
      jid,
      { [`${pase}`]: data, mimetype: mime, ...options },
      { quoted, ...ephemeral },
    );
  };

  (conn.adReply = (
    jid,
    text,
    title = "",
    body = "",
    buffer,
    source = "",
    quoted,
    options,
  ) => {
    let { data } = conn.getFile(buffer, true);
    return conn.sendMessage(
      jid,
      {
        text: text,
        contextInfo: {
          mentionedJid: conn.parseMention(text),
          externalAdReply: {
            showAdAttribution: true,
            mediaType: 1,
            title: title,
            body: body,
            thumbnailUrl: "https://telegra.ph/file/dc229854bebc5fe9ccf01.jpg",
            renderLargerThumbnail: true,
            sourceUrl: source,
          },
        },
      },
      { quoted: quoted, ...options, ...ephemeral },
    );

    enumerable: true;
  }),
    /**
     * Send Media/File with Automatic Type Specifier
     * @param {String} jid
     * @param {String|Buffer} path
     * @param {String} filename
     * @param {String} caption
     * @param {config.proto.WebMessageInfo} quoted
     * @param {Boolean} ptt
     * @param {Object} options
     */
    (conn.sendFile = async (
      jid,
      path,
      filename = "",
      caption = "",
      quoted,
      ptt = false,
      options = {},
    ) => {
      let type = await conn.getFile(path, true);
      let { res, data: file, filename: pathFile } = type;
      if ((res && res.status !== 200) || file.length <= 65536) {
        try {
          throw { json: JSON.parse(file.toString()) };
        } catch (e) {
          if (e.json) throw e.json;
        }
      }
      let opt = { filename };
      if (quoted) opt.quoted = quoted;
      if (!type) options.asDocument = true;
      let mtype = "",
        mimetype = type.mime,
        convert;
      if (
        /webp/.test(type.mime) ||
        (/image/.test(type.mime) && options.asSticker)
      )
        mtype = "sticker";
      else if (
        /image/.test(type.mime) ||
        (/webp/.test(type.mime) && options.asImage)
      )
        mtype = "image";
      else if (/video/.test(type.mime)) mtype = "video";
      else if (/audio/.test(type.mime))
        (convert = await (ptt ? toPTT : toAudio)(file, type.ext)),
          (file = convert.data),
          (pathFile = convert.filename),
          (mtype = "audio"),
          (mimetype = "audio/mpeg");
      else mtype = "document";
      if (options.asDocument) mtype = "document";

      let message = {
        ...options,
        caption,
        filename,
        ptt,
        [mtype]: { url: pathFile },
        mimetype,
      };
      let m;
      try {
        m = await conn.sendMessage(jid, message, { ...opt, ...options });
      } catch (e) {
        console.error(e);
        m = null;
      } finally {
        if (!m)
          m = await conn.sendMessage(
            jid,
            { ...message, [mtype]: file },
            { ...opt, ...options, ...ephemeral },
          );
        return m;
      }
    });

  conn.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
    let buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await (await fetch(path)).buffer()
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : Buffer.alloc(0);
    let buffer;
    if (options && (options.packname || options.author)) {
      buffer = await writeExifImg(buff, options);
    } else {
      buffer = await imageToWebp(buff);
    }

    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted, ...ephemeral },
    );
    return buffer;
  };

  conn.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
    let buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await await fetchBuffer(path)
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : Buffer.alloc(0);

    let buffer;

    if (options && (options.packname || options.author)) {
      buffer = await writeExifVid(buff, options);
    } else {
      buffer = await videoToWebp(buff);
    }

    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted, ...ephemeral },
    );

    return buffer;
  };
  /**
   * Send Contact
   * @param {String} jid
   * @param {String} number
   * @param {String} name
   * @param {Object} quoted
   * @param {Object} options
   */
  (conn.sendContact = async (jid, data, quoted, options) => {
    if (!Array.isArray(data[0]) && typeof data[0] === "string") data = [data];
    let contacts = [];
    for (let [number, name] of data) {
      number = number.replace(/[^0-9]/g, "");
      let njid = number + "@s.whatsapp.net";
      let biz = (await conn.getBusinessProfile(njid).catch((_) => null)) || {};
      let vcard = `
BEGIN:VCARD
VERSION:3.0
FN:${name.replace(/\n/g, "\\n")}
ORG:
item1.TEL;waid=${number}:${PhoneNumber("+" + number).getNumber("international")}
item1.X-ABLabel:Ponsel${
        biz.description
          ? `
item2.EMAIL;type=INTERNET:${(biz.email || "").replace(/\n/g, "\\n")}
item2.X-ABLabel:Email
PHOTO;BASE64:${((await conn.getFile(await conn.profilePictureUrl(njid)).catch((_) => ({}))) || {}).number?.toString("base64")}
X-WA-BIZ-DESCRIPTION:${(biz.description || "").replace(/\n/g, "\\n")}
X-WA-BIZ-NAME:${name.replace(/\n/g, "\\n")}
`
          : ""
      }
END:VCARD
`.trim();
      contacts.push({
        vcard,
        displayName: name,
      });
    }
    return conn.sendMessage(
      jid,
      {
        ...options,
        contacts: {
          ...options,
          displayName:
            (contacts.length >= 2
              ? `${contacts.length} kontak`
              : contacts[0].displayName) || null,
          contacts,
        },
      },
      {
        quoted,
        ...options,
        ...ephemeral,
      },
    );
    enumerable: true;
  }),
    /*    (conn.sendList = async (
      jid,
      header,
      footer,
      separate,
      buttons,
      rows,
      quoted,
      options,
    ) => {
      const inputArray = rows.flat();
      const result = inputArray.reduce((acc, curr, index) => {
        if (index % 2 === 1) {
          const [title, rowId, description] = curr[0];
          acc.push({
            title,
            rowId,
            description,
          });
        }
        return acc;
      }, []);
      let teks = result
        .map((v, index) => {
          return `${v.title || ""}\n${v.rowId || ""}\n${v.description || ""}`.trim();
        })
        .filter((v) => v)
        .join("\n\n");
      return conn.sendMessage(
        jid,
        {
          ...options,
          text: teks,
        },
        {
          quoted,
          ...options,
        },
      );
    }),*/
    /**
     * Reply to a message
     * @param {String} jid
     * @param {String|Object} text
     * @param {Object} quoted
     * @param {Object} options
     */
    (conn.reply = (jid, text = "", quoted, options) => {
      return Buffer.isBuffer(text)
        ? conn.sendFile(jid, text, "file", "", quoted, false, options)
        : conn.sendMessage(
            jid,
            { ...options, text, mentions: conn.parseMention(text) },
            {
              quoted,
              ...options,
              mentions: conn.parseMention(text),
              ...ephemeral,
            },
          );
    });

  conn.resize = async (image, width, height) => {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy
      .resize(width, height)
      .getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
  };

  conn.sendCarousel = async (jid, messages, quoted, json = {}, options) => {
    if (messages.length >= 1) {
      const cards = await Promise.all(
        messages.map(
          async ([
            text = "",
            footer = "",
            buffer,
            buttons,
            copy,
            urls,
            list,
          ]) => {
            let img, video;
            if (/^https?:\/\//i.test(buffer)) {
              try {
                const response = await fetch(buffer);
                const contentType = response.headers.get("content-type");
                if (/^image\//i.test(contentType)) {
                  img = await config.prepareWAMessageMedia(
                    {
                      image: {
                        url: buffer,
                      },
                    },
                    {
                      upload: conn.waUploadToServer,
                      ...options,
                    },
                  );
                } else if (/^video\//i.test(contentType)) {
                  video = await config.prepareWAMessageMedia(
                    {
                      video: {
                        url: buffer,
                      },
                    },
                    {
                      upload: conn.waUploadToServer,
                      ...options,
                    },
                  );
                } else {
                  console.error("Jenis MIME tidak kompatibel:", contentType);
                }
              } catch (error) {
                console.error("Gagal mendapatkan jenis MIME:", error);
              }
            } else {
              try {
                const type = await conn.getFile(buffer);
                if (/^image\//i.test(type.mime)) {
                  img = await config.prepareWAMessageMedia(
                    {
                      image: /^https?:\/\//i.test(buffer)
                        ? { url: buffer }
                        : type && type?.data,
                    },
                    {
                      upload: conn.waUploadToServer,
                      ...options,
                    },
                  );
                } else if (/^video\//i.test(type.mime)) {
                  video = await config.prepareWAMessageMedia(
                    {
                      video: /^https?:\/\//i.test(buffer)
                        ? { url: buffer }
                        : type && type?.data,
                    },
                    {
                      upload: conn.waUploadToServer,
                      ...options,
                    },
                  );
                }
              } catch (error) {
                console.error("Gagal mendapatkan tipe file:", error);
              }
            }
            const dynamicButtons = buttons.map((btn) => ({
              name: "quick_reply",
              buttonParamsJson: JSON.stringify({
                display_text: btn[0],
                id: btn[1],
              }),
            }));

            dynamicButtons.push(
              copy &&
                (typeof copy === "string" || typeof copy === "number") && {
                  name: "cta_copy",
                  buttonParamsJson: JSON.stringify({
                    display_text: "Copy",
                    copy_code: copy,
                  }),
                },
            );

            urls?.forEach((url) => {
              dynamicButtons.push({
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: url[0],
                  url: url[1],
                  merBott_url: url[1],
                }),
              });
            });

            list?.forEach((lister) => {
              dynamicButtons.push({
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                  title: lister[0],
                  sections: lister[1],
                }),
              });
            });

            return {
              body: config.proto.Message.InteractiveMessage.Body.fromObject({
                text: text || namebot,
              }),
              footer: config.proto.Message.InteractiveMessage.Footer.fromObject({
                text: footer || wm,
              }),
              header: config.proto.Message.InteractiveMessage.Header.fromObject({
                title: "",
                subtitle: wm,
                hasMediaAttachment:
                  img?.imageMessage || video?.videoMessage ? true : false,
                imageMessage: img?.imageMessage || null,
                videoMessage: video?.videoMessage || null,
              }),
              nativeFlowMessage:
                config.proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                  buttons: dynamicButtons.filter(Boolean),
                  messageParamsJson: "",
                }),
              ...Object.assign({
                mentions: conn.parseMention(text),
                contextInfo: {
                  mentionedJid: conn.parseMention(text),
                },
              }),
            };
          },
        ),
      );

      const interactiveMessage = config.proto.Message.InteractiveMessage.create({
        body: config.proto.Message.InteractiveMessage.Body.fromObject({
          text: json.body || "",
        }),
        footer: config.proto.Message.InteractiveMessage.Footer.fromObject({
          text: json.footer || "",
        }),
        header: config.proto.Message.InteractiveMessage.Header.fromObject({
          title: json.headers || "",
          subtitle: wm,
          hasMediaAttachment: false,
        }),
        carouselMessage:
          config.proto.Message.InteractiveMessage.CarouselMessage.fromObject({
            cards,
          }),
        ...Object.assign({
          contextInfo: {
            mentionedJid: [
              ...conn.parseMention(json.body),
              ...conn.parseMention(json.footer),
            ],
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: "120363297546817012@newsletter",
              serverMessageId: 173,
              newsletterName: `AkiraaBotz || Dont forget for follow ⤵️`,
            },
          },
        }),
      });

      const messageContent = config.proto.Message.fromObject({
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
            interactiveMessage,
          },
        },
      });

      const msgs = await config.generateWAMessageFromContent(jid, messageContent, {
        userJid: conn.user.jid,
        quoted: quoted,
        upload: conn.waUploadToServer,
        ...ephemeral,
      });

      return conn.relayMessage(jid, msgs.message, {
        messageId: msgs.key.id,
      });
    }
  };

  conn.sendCopy = async (jid, array, quoted, json) => {
    const result = [];
    for (const pair of array) {
      const obj = {
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: pair[0],
          copy_code: pair[1],
        }),
      };
      result.push(obj);
    }

    if (json.url) {
      let file = await conn.getFile(json.url, true);
      let mime = file.mime.split("/")[0];
      if (mime === "image") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { image: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result,
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      } else if (mime === "video") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { video: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result || [{ text: "" }],
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );
        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      }
    } else {
      let msg = config.generateWAMessageFromContent(
        jid,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
              },
              interactiveMessage: config.proto.Message.InteractiveMessage.create({
                body: config.proto.Message.InteractiveMessage.Body.create({
                  text: json.body,
                }),
                footer: config.proto.Message.InteractiveMessage.Footer.create({
                  text: json.footer,
                }),
                header: config.proto.Message.InteractiveMessage.Header.create({
                  hasMediaAttachment: false,
                }),
                nativeFlowMessage:
                  config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                    buttons: result || [{ text: "" }],
                  }),
                contextInfo: {
                  mentionedJid: [
                    ...conn.parseMention(json.body),
                    ...conn.parseMention(json.footer),
                  ],
                  forwardingScore: 1,
                  isForwarded: true,
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: "120363297546817012@newsletter",
                    serverMessageId: 173,
                    newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                  },
                },
              }),
            },
          },
        },
        {
          userJid: conn.user.jid,
          quoted: quoted,
          ...ephemeral,
        },
      );

      return conn.relayMessage(msg.key.remoteJid, msg.message, {
        messageId: msg.key.id,
      });
    }
  };

  conn.sendUrl = async (jid, array, quoted, json) => {
    const result = [];
    for (const pair of array) {
      const obj = {
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: pair[0],
          url: pair[1],
          merBott_url: pair[1],
        }),
      };
      result.push(obj);
    }

    if (json.url) {
      let file = await conn.getFile(json.url, true);
      let mime = file.mime.split("/")[0];
      if (mime === "image") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { image: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result,
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      } else if (mime === "video") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { video: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result || [{ text: "" }],
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );
        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      }
    } else {
      let msg = config.generateWAMessageFromContent(
        jid,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
              },
              interactiveMessage: config.proto.Message.InteractiveMessage.create({
                body: config.proto.Message.InteractiveMessage.Body.create({
                  text: json.body,
                }),
                footer: config.proto.Message.InteractiveMessage.Footer.create({
                  text: json.footer,
                }),
                header: config.proto.Message.InteractiveMessage.Header.create({
                  hasMediaAttachment: false,
                }),
                nativeFlowMessage:
                  config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                    buttons: result || [{ text: "" }],
                  }),
                contextInfo: {
                  mentionedJid: [
                    ...conn.parseMention(json.body),
                    ...conn.parseMention(json.footer),
                  ],
                  forwardingScore: 1,
                  isForwarded: true,
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: "120363297546817012@newsletter",
                    serverMessageId: 173,
                    newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                  },
                },
              }),
            },
          },
        },
        {
          userJid: conn.user.jid,
          quoted: quoted,
          upload: conn.waUploadToServer,
          ...ephemeral,
        },
      );

      return conn.relayMessage(msg.key.remoteJid, msg.message, {
        messageId: msg.key.id,
      });
    }
  };

  conn.sendButton = async (jid, array, quoted, json) => {
    const result = [];
    for (const pair of array) {
      const obj = {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: pair[0],
          id: pair[1],
        }),
      };
      result.push(obj);
    }

    if (json.url) {
      let file = await conn.getFile(json.url, true);
      let mime = file.mime.split("/")[0];
      if (mime === "image") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { image: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result,
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      } else if (mime === "video") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { video: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result || [{ text: "" }],
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );
        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      }
    } else {
      let msg = config.generateWAMessageFromContent(
        jid,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
              },
              interactiveMessage: config.proto.Message.InteractiveMessage.create({
                body: config.proto.Message.InteractiveMessage.Body.create({
                  text: json.body,
                }),
                footer: config.proto.Message.InteractiveMessage.Footer.create({
                  text: json.footer,
                }),
                header: config.proto.Message.InteractiveMessage.Header.create({
                  hasMediaAttachment: false,
                }),
                nativeFlowMessage:
                  config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                    buttons: result || [{ text: "" }],
                  }),
                contextInfo: {
                  mentionedJid: [
                    ...conn.parseMention(json.body),
                    ...conn.parseMention(json.footer),
                  ],
                  forwardingScore: 1,
                  isForwarded: true,
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: "120363297546817012@newsletter",
                    serverMessageId: 173,
                    newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                  },
                },
              }),
            },
          },
        },
        {
          userJid: conn.user.jid,
          quoted: quoted,
          upload: conn.waUploadToServer,
          ...ephemeral,
        },
      );

      return conn.relayMessage(msg.key.remoteJid, msg.message, {
        messageId: msg.key.id,
      });
    }
  };

  conn.sendList = async (jid, name, array, quoted, json) => {
    let transformedData = array.map((item) => ({
      ...(item.headers ? { title: item.headers } : {}),
      rows: item.rows.map((row) => ({
        header: row.headers,
        title: row.title,
        description: row.body,
        id: row.command,
      })),
    }));

    let sections = transformedData;
    const listMessage = {
      title: name,
      sections,
    };

    let result = [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify(listMessage),
      },
    ];

    if (json.url) {
      let file = await conn.getFile(json.url, true);
      let mime = file.mime.split("/")[0];
      if (mime === "image") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { image: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result,
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      } else if (mime === "video") {
        let msg = config.generateWAMessageFromContent(
          jid,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2,
                },
                interactiveMessage: config.proto.Message.InteractiveMessage.create({
                  body: config.proto.Message.InteractiveMessage.Body.create({
                    text: json.body,
                  }),
                  footer: config.proto.Message.InteractiveMessage.Footer.create({
                    text: json.footer,
                  }),
                  header: config.proto.Message.InteractiveMessage.Header.create({
                    hasMediaAttachment: true,
                    ...(await config.prepareWAMessageMedia(
                      { video: { url: json.url } },
                      { upload: conn.waUploadToServer },
                    )),
                  }),
                  nativeFlowMessage:
                    config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                      buttons: result || [{ text: "" }],
                    }),
                  contextInfo: {
                    mentionedJid: [
                      ...conn.parseMention(json.body),
                      ...conn.parseMention(json.footer),
                    ],
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                      newsletterJid: "120363297546817012@newsletter",
                      serverMessageId: 173,
                      newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                    },
                  },
                }),
              },
            },
          },
          {
            userJid: conn.user.jid,
            quoted: quoted,
            upload: conn.waUploadToServer,
            ...ephemeral,
          },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
          messageId: msg.key.id,
        });
      }
    } else {
      let msg = config.generateWAMessageFromContent(
        jid,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
              },
              interactiveMessage: config.proto.Message.InteractiveMessage.create({
                body: config.proto.Message.InteractiveMessage.Body.create({
                  text: json.body,
                }),
                footer: config.proto.Message.InteractiveMessage.Footer.create({
                  text: json.footer,
                }),
                header: config.proto.Message.InteractiveMessage.Header.create({
                  hasMediaAttachment: false,
                }),
                nativeFlowMessage:
                  config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                    buttons: result || [{ text: "" }],
                  }),
                contextInfo: {
                  mentionedJid: [
                    ...conn.parseMention(json.body),
                    ...conn.parseMention(json.footer),
                  ],
                  forwardingScore: 1,
                  isForwarded: true,
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: "120363297546817012@newsletter",
                    serverMessageId: 173,
                    newsletterName: `Akiraa Bot || Don't forget for follow ⤵️`,
                  },
                },
              }),
            },
          },
        },
        {
          userJid: conn.user.jid,
          quoted: quoted,
          upload: conn.waUploadToServer,
          ...ephemeral,
        },
      );
      return conn.relayMessage(msg.key.remoteJid, msg.message, {
        messageId: msg.key.id,
      });
    }
  };
  conn.fakeReply = (
    jid,
    text = "",
    fakeJid = conn.user.jid,
    fakeText = "",
    fakeGroupJid,
    options,
  ) => {
    return conn.sendMessage(
      jid,
      { text: text },
      {
        ephemeralExpiration: 86400,
        quoted: {
          key: {
            fromMe: fakeJid == conn.user.jid,
            participant: fakeJid,
            ...(fakeGroupJid ? { remoteJid: fakeGroupJid } : {}),
          },
          message: { conversation: fakeText },
          ...options,
        },
      },
    );
  };

  conn.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      let decode = config.jidDecode(jid) || {};
      return (
        (decode.user && decode.server && decode.user + "@" + decode.server) ||
        jid
      );
    } else return jid;
  };

  /**
   *
   * @param {*} jid
   * @param {*} text
   * @param {*} quoted
   * @param {*} options
   * @returns
   */
  conn.sendText = (jid, text, quoted = "", options) =>
    conn.sendMessage(jid, { text: text, ...options }, { quoted, ...ephemeral });

  /**
   * sendGroupV4Invite
   * @param {String} jid
   * @param {*} participant
   * @param {String} inviteCode
   * @param {Number} inviteExpiration
   * @param {String} groupName
   * @param {String} caption
   * @param {*} options
   * @returns
   */
  conn.sendGroupV4Invite = async (
    jid,
    participant,
    inviteCode,
    inviteExpiration,
    groupName = "unknown subject",
    caption = "Invitation to join my WhatsApp group",
    options = {},
  ) => {
    let msg = config.proto.Message.fromObject({
      groupInviteMessage: config.proto.GroupInviteMessage.fromObject({
        inviteCode,
        inviteExpiration:
          parseInt(inviteExpiration) || +new Date(new Date() + 3 * 86400000),
        groupJid: jid,
        groupName: groupName ? groupName : this.getName(jid),
        caption,
      }),
    });
    let message = await this.prepareMessageFromContent(
      participant,
      msg,
      options,
    );
    await this.relayWAMessage(message);
    return message;
  };

  /**
   * cMod
   * @param {String} jid
   * @param {config.proto.WebMessageInfo} message
   * @param {String} text
   * @param {String} sender
   * @param {*} options
   * @returns
   */
  conn.cMod = (
    jid,
    message,
    text = "",
    sender = conn.user.jid,
    options = {},
  ) => {
    let copy = message.toJSON();
    let mtype = Object.keys(copy.message)[0];
    let isEphemeral = false; // mtype === 'ephemeralMessage'
    if (isEphemeral) {
      mtype = Object.keys(copy.message.ephemeralMessage.message)[0];
    }
    let msg = isEphemeral
      ? copy.message.ephemeralMessage.message
      : copy.message;
    let content = msg[mtype];
    if (typeof content === "string") msg[mtype] = text || content;
    else if (content.caption) content.caption = text || content.caption;
    else if (content.text) content.text = text || content.text;
    if (typeof content !== "string") msg[mtype] = { ...content, ...options };
    if (copy.participant)
      sender = copy.participant = sender || copy.participant;
    else if (copy.key.participant)
      sender = copy.key.participant = sender || copy.key.participant;
    if (copy.key.remoteJid.includes("@s.whatsapp.net"))
      sender = sender || copy.key.remoteJid;
    else if (copy.key.remoteJid.includes("@broadcast"))
      sender = sender || copy.key.remoteJid;
    copy.key.remoteJid = jid;
    copy.key.fromMe = config.areJidsSameUser(sender, conn.user.id) || false;
    return config.proto.WebMessageInfo.fromObject(copy);
  };

  /**
   * Exact Copy Forward
   * @param {String} jid
   * @param {config.proto.WebMessageInfo} message
   * @param {Boolean|Number} forwardingScore
   * @param {Object} options
   */
  conn.copyNForward = async (
    jid,
    message,
    forwardingScore = true,
    options = {},
  ) => {
    let m = config.generateForwardMessageContent(message, !!forwardingScore);
    let mtype = Object.keys(m)[0];
    if (
      forwardingScore &&
      typeof forwardingScore == "number" &&
      forwardingScore > 1
    )
      m[mtype].contextInfo.forwardingScore += forwardingScore;
    m = config.generateWAMessageFromContent(jid, m, {
      ...options,
      userJid: conn.user.id,
    });
    await conn.relayMessage(jid, m.message, {
      messageId: m.key.id,
      additionalAttributes: { ...options },
    });
    return m;
  };

  conn.loadMessage =
    conn.loadMessage ||
    (async (messageID) => {
      return Object.entries(conn.chats)
        .filter(([_, { messages }]) => typeof messages === "object")
        .find(([_, { messages }]) =>
          Object.entries(messages).find(
            ([k, v]) => k === messageID || v.key?.id === messageID,
          ),
        )?.[1].messages?.[messageID];
    });

  /**
   * Download media message
   * @param {Object} m
   * @param {String} type
   * @param {fs.PathLike|fs.promises.FileHandle} filename
   * @returns {Promise<fs.PathLike|fs.promises.FileHandle|Buffer>}
   */
  conn.downloadM = async (m, type, saveToFile) => {
    if (!m || !(m.url || m.directPath)) return Buffer.alloc(0);
    const stream = await config.downloadContentFromMessage(m, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    if (saveToFile) var { filename } = await conn.getFile(buffer, true);
    return saveToFile && fs.existsSync(filename) ? filename : buffer;
  };

  conn.downloadAndSaveMediaMessage = async (
    message,
    filename,
    attachExtension = true,
  ) => {
    let quoted = message.msg ? message.msg : message;
    let mime = (message.msg || message).mimetype || "";
    let messageType = message.mtype
      ? message.mtype.replace(/Message/gi, "")
      : mime.split("/")[0];
    const stream = await config.downloadContentFromMessage(quoted, messageType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    let type = await FileType.fromBuffer(buffer);
    trueFileName = attachExtension ? filename + "." + type.ext : filename;
    // save to file
    await fs.writeFileSync(trueFileName, buffer);
    return trueFileName;
  };

  /**
   * parseMention(s)
   * @param {string} text
   * @returns {string[]}
   */
  conn.parseMention = (text = "") => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
      (v) => v[1] + "@s.whatsapp.net",
    );
  };
  /**
   * Read message
   * @param {String} jid
   * @param {String|undefined|null} participant
   * @param {String} messageID
   */
  conn.chatRead = async (jid, participant = conn.user.jid, messageID) => {
    return await conn.sendReadReceipt(jid, participant, [messageID]);
  };

  conn.sendStimg = async (jid, path, quoted, options = {}) => {
    let buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await (await fetch(path)).buffer()
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : Buffer.alloc(0);
    let buffer;
    if (options && (options.packname || options.author)) {
      buffer = await writeExifImg(buff, options);
    } else {
      buffer = await imageToWebp(buff);
    }
    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted, ...ephemeral },
    );
    return buffer;
  };

  conn.sendStvid = async (jid, path, quoted, options = {}) => {
    let buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await getBuffer(path)
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : Buffer.alloc(0);
    let buffer;
    if (options && (options.packname || options.author)) {
      buffer = await writeExifVid(buff, options);
    } else {
      buffer = await videoToWebp(buff);
    }
    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted, ...ephemeral },
    );
    return buffer;
  };

  /**
   * Parses string into mentionedJid(s)
   * @param {String} text
   */
  conn.parseMention = (text = "") => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
      (v) => v[1] + "@s.whatsapp.net",
    );
  };

  conn.sendTextWithMentions = async (jid, text, quoted, options = {}) =>
    conn.sendMessage(
      jid,
      {
        text: text,
        contextInfo: {
          mentionedJid: [...text.matchAll(/@(\d{0,16})/g)].map(
            (v) => v[1] + "@s.whatsapp.net",
          ),
        },
        ...options,
      },
      { quoted, ...ephemeral },
    );

  /**
   * Get name from jid
   * @param {String} jid
   * @param {Boolean} withoutContact
   */
  conn.getName = (jid = "", withoutContact = false) => {
    jid = conn.decodeJid(jid);
    withoutContact = this.withoutContact || withoutContact;
    let v;
    if (jid.endsWith("@g.us"))
      return new Promise(async (resolve) => {
        v = conn.chats[jid] || {};
        if (!(v.name || v.subject)) v = (await conn.groupMetadata(jid)) || {};
        resolve(
          v.name ||
            v.subject ||
            PhoneNumber("+" + jid.replace("@s.whatsapp.net", "")).getNumber(
              "international",
            ),
        );
      });
    else
      v =
        jid === "0@s.whatsapp.net"
          ? {
              jid,
              vname: "WhatsApp",
            }
          : config.areJidsSameUser(jid, conn.user.id)
            ? conn.user
            : conn.chats[jid] || {};
    return (
      (withoutContact ? "" : v.name) ||
      v.subject ||
      v.vname ||
      v.notify ||
      v.verifiedName ||
      PhoneNumber("+" + jid.replace("@s.whatsapp.net", "")).getNumber(
        "international",
      )
    );
  };

  /**
   * to process MessageStubType
   * @param {config.proto.WebMessageInfo} m
   */
  conn.processMessageStubType = async (m) => {
    /**
     * to process MessageStubType
     * @param {import('@adiwajshing/baileys').config.proto.WebMessageInfo} m
     */
    if (!m.messageStubType) return;
    const chat = conn.decodeJid(
      m.key.remoteJid || m.message?.senderKeyDistributionMessage?.groupId || "",
    );
    if (!chat || chat === "status@broadcast") return;
    const emitGroupUpdate = (update) => {
      conn.ev.emit("groups.update", [{ id: chat, ...update }]);
    };
    switch (m.messageStubType) {
      case config.WAMessageStubType.REVOKE:
      case config.WAMessageStubType.GROUP_BotGE_INVITE_LINK:
        emitGroupUpdate({ revoke: m.messageStubParameters[0] });
        break;
      case config.WAMessageStubType.GROUP_BotGE_ICON:
        emitGroupUpdate({ icon: m.messageStubParameters[0] });
        break;
      default: {
        console.log({
          messageStubType: m.messageStubType,
          messageStubParameters: m.messageStubParameters,
          type: config.WAMessageStubType[m.messageStubType],
        });
        break;
      }
    }
    const isGroup = chat.endsWith("@g.us");
    if (!isGroup) return;
    let chats = conn.chats[chat];
    if (!chats) chats = conn.chats[chat] = { id: chat };
    chats.isChats = true;
    const metadata = await conn.groupMetadata(chat).catch((_) => null);
    if (!metadata) return;
    chats.subject = metadata.subject;
    chats.metadata = metadata;
  };
  conn.insertAllGroup = async () => {
    const groups =
      (await conn.groupFetchAllParticipating().catch((_) => null)) || {};
    for (const group in groups)
      conn.chats[group] = {
        ...(conn.chats[group] || {}),
        id: group,
        subject: groups[group].subject,
        isChats: true,
        metadata: groups[group],
      };
    return conn.chats;
  };

  /*conn.processMessageStubType = async (m) => {
        if (!m.messageStubType) return
        const mtype = Object.keys(m.message || {})[0]
        const chat = conn.decodeJid(m.key.remoteJid || m.message[mtype] && m.message[mtype].groupId || '')
        const isGroup = chat.endsWith('@g.us')
        if (!isGroup) return
        let chats = conn.chats[chat]
        if (!chats) chats = conn.chats[chat] = { id: chat }
        chats.isChats = true
        const metadata = await conn.groupMetadata(chat).catch(_ => null)
        if (!metadata) return
        chats.subject = metadata.subject
        chats.metadata = metadata
    }*/

  /**
   * pushMessage
   * @param {config.proto.WebMessageInfo[]} m
   */
  conn.pushMessage = async (m) => {
    /**
     * pushMessage
     * @param {import('@adiwajshing/baileys').config.proto.WebMessageInfo[]} m
     */
    if (!m) return;
    if (!Array.isArray(m)) m = [m];
    for (const message of m) {
      try {
        // if (!(message instanceof config.proto.WebMessageInfo)) continue // https://github.com/adiwajshing/Baileys/pull/696/commits/6a2cb5a4139d8eb0a75c4c4ea7ed52adc0aec20f
        if (!message) continue;
        if (
          message.messageStubType &&
          message.messageStubType != config.WAMessageStubType.CIPHERTEXT
        )
          conn.processMessageStubType(message).catch(console.error);
        const _mtype = Object.keys(message.message || {});
        const mtype =
          (!["senderKeyDistributionMessage", "messageContextInfo"].includes(
            _mtype[0],
          ) &&
            _mtype[0]) ||
          (_mtype.length >= 3 &&
            _mtype[1] !== "messageContextInfo" &&
            _mtype[1]) ||
          _mtype[_mtype.length - 1];
        const chat = conn.decodeJid(
          message.key.remoteJid ||
            message.message?.senderKeyDistributionMessage?.groupId ||
            "",
        );
        if (message.message?.[mtype]?.contextInfo?.quotedMessage) {
          /**
           * @type {import('@adiwajshing/baileys').config.proto.IContextInfo}
           */
          let context = message.message[mtype].contextInfo;
          let participant = conn.decodeJid(context.participant);
          const remoteJid = conn.decodeJid(context.remoteJid || participant);
          /**
           * @type {import('@adiwajshing/baileys').config.proto.IMessage}
           *
           */
          let quoted = message.message[mtype].contextInfo.quotedMessage;
          if (remoteJid && remoteJid !== "status@broadcast" && quoted) {
            let qMtype = Object.keys(quoted)[0];
            if (qMtype == "conversation") {
              quoted.extendedTextMessage = { text: quoted[qMtype] };
              delete quoted.conversation;
              qMtype = "extendedTextMessage";
            }

            if (!quoted[qMtype].contextInfo) quoted[qMtype].contextInfo = {};
            quoted[qMtype].contextInfo.mentionedJid =
              context.mentionedJid ||
              quoted[qMtype].contextInfo.mentionedJid ||
              [];
            const isGroup = remoteJid.endsWith("g.us");
            if (isGroup && !participant) participant = remoteJid;
            const qM = {
              key: {
                remoteJid,
                fromMe: config.areJidsSameUser(conn.user.jid, remoteJid),
                id: context.stanzaId,
                participant,
              },
              message: JSON.parse(JSON.stringify(quoted)),
              ...(isGroup ? { participant } : {}),
            };
            let qChats = conn.chats[participant];
            if (!qChats)
              qChats = conn.chats[participant] = {
                id: participant,
                isChats: !isGroup,
              };
            if (!qChats.messages) qChats.messages = {};
            if (!qChats.messages[context.stanzaId] && !qM.key.fromMe)
              qChats.messages[context.stanzaId] = qM;
            let qChatsMessages;
            if ((qChatsMessages = Object.entries(qChats.messages)).length > 40)
              qChats.messages = Object.fromEntries(
                qChatsMessages.slice(30, qChatsMessages.length),
              ); // maybe avoid memory leak
          }
        }
        if (!chat || chat === "status@broadcast") continue;
        const isGroup = chat.endsWith("@g.us");
        let chats = conn.chats[chat];
        if (!chats) {
          if (isGroup) await conn.insertAllGroup().catch(console.error);
          chats = conn.chats[chat] = {
            id: chat,
            isChats: true,
            ...(conn.chats[chat] || {}),
          };
        }
        let metadata, sender;
        if (isGroup) {
          if (!chats.subject || !chats.metadata) {
            metadata =
              (await conn.groupMetadata(chat).catch((_) => ({}))) || {};
            if (!chats.subject) chats.subject = metadata.subject || "";
            if (!chats.metadata) chats.metadata = metadata;
          }
          sender = conn.decodeJid(
            (message.key?.fromMe && conn.user.id) ||
              message.participant ||
              message.key?.participant ||
              chat ||
              "",
          );
          if (sender !== chat) {
            let chats = conn.chats[sender];
            if (!chats) chats = conn.chats[sender] = { id: sender };
            if (!chats.name) chats.name = message.pushName || chats.name || "";
          }
        } else if (!chats.name)
          chats.name = message.pushName || chats.name || "";
        if (
          ["senderKeyDistributionMessage", "messageContextInfo"].includes(mtype)
        )
          continue;
        chats.isChats = true;
        if (!chats.messages) chats.messages = {};
        const fromMe =
          message.key.fromMe || config.areJidsSameUser(sender || chat, conn.user.id);
        if (
          !["config.protocolMessage"].includes(mtype) &&
          !fromMe &&
          message.messageStubType != config.WAMessageStubType.CIPHERTEXT &&
          message.message
        ) {
          delete message.message.messageContextInfo;
          delete message.message.senderKeyDistributionMessage;
          chats.messages[message.key.id] = JSON.parse(
            JSON.stringify(message, null, 2),
          );
          let chatsMessages;
          if ((chatsMessages = Object.entries(chats.messages)).length > 40)
            chats.messages = Object.fromEntries(
              chatsMessages.slice(30, chatsMessages.length),
            );
        }
      } catch (e) {
        console.error(e);
      }
    }
  };

  /*
   * Send Polling
   */
  conn.getFile = async (path) => {
    let res;
    let data = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await (res = await fetch(path)).buffer()
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : typeof path === "string"
              ? path
              : Buffer.alloc(0);
    if (!Buffer.isBuffer(data)) throw new TypeError("Result is not a buffer");
    let type = (await FileType.fromBuffer(data)) || {
      mime: "application/octet-stream",
      ext: ".bin",
    };

    return {
      res,
      ...type,
      data,
    };
  };

  conn.sendPoll = async (jid, name = "", optiPoll, options) => {
    if (!Array.isArray(optiPoll[0]) && typeof optiPoll[0] === "string")
      optiPoll = [optiPoll];
    if (!options) options = {};
    const pollMessage = {
      name: name,
      options: optiPoll.map((btn) => ({ optionName: btn[0] || "" })),
      selectableOptionsCount: 1,
    };
    return conn.relayMessage(
      jid,
      { pollCreationMessage: pollMessage },
      { ...options },
    );
  };

  /*
   * Set auto Bio
   */

  conn.setBio = async (status) => {
    return await conn.query({
      tag: "iq",
      attrs: {
        to: "s.whatsapp.net",
        type: "set",
        xmlns: "status",
      },
      content: [
        {
          tag: "status",
          attrs: {},
          content: Buffer.from(status, "utf-8"),
        },
      ],
    });
    // <iq to="s.whatsapp.net" type="set" xmlns="status" id="21168.6213-69"><status>"Hai, saya menggunakan WhatsApp"</status></iq>
  };

  /**
   *
   * @param  {...any} args
   * @returns
   */
  conn.format = (...args) => {
    return util.format(...args);
  };

  /**
   *
   * @param {String} url
   * @param {Object} options
   * @returns
   */
  conn.getBuffer = async (url, options) => {
    try {
      options ? options : {};
      const res = await axios({
        method: "get",
        url,
        headers: {
          DNT: 1,
          "Upgrade-Insecure-Request": 1,
        },
        ...options,
        responseType: "arraybuffer",
      });
      return res.data;
    } catch (e) {
      console.log(`Error : ${e}`);
    }
  };

  /**
   * Serialize Message, so it easier to manipulate
   * @param {Object} m
   */
  conn.serializeM = (m) => {
    return exports.smsg(conn, m);
  };

  Object.defineProperty(conn, "name", {
    value: "WASocket",
    configurable: true,
  });
  return conn;
};

function isNumber() {
  const int = parseInt(this);
  return typeof int === "number" && !isNaN(int);
}

function getRandom() {
  if (Array.isArray(this) || this instanceof String)
    return this[Math.floor(Math.random() * this.length)];
  return Math.floor(Math.random() * this);
}

function rand(isi) {
  return isi[Math.floor(Math.random() * isi.length)];
}
