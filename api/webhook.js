module.exports = async (req, res) => {
  // Hanya memproses request bertipe POST dari Telegram
  if (req.method !== 'POST') return res.status(200).send('OK');

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL; 
  
  const update = req.body;
  console.log("1. Menerima dari Telegram:", JSON.stringify(update));

  const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
  const text = update.message?.text;
  const callbackData = update.callback_query?.data;

  if (!chatId) return res.status(200).send('OK');

  // Fungsi bantu kirim pesan ke Telegram
  const sendTG = async (textMsg, keyboard = null) => {
    let payload = { chat_id: chatId, text: textMsg, parse_mode: "Markdown" };
    if (keyboard) payload.reply_markup = keyboard;
    
    console.log("2. Kirim balasan ke TG:", JSON.stringify(payload));
    
    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', 
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    
    const tgResText = await tgRes.text();
    console.log("3. Respon resmi dari Telegram:", tgResText); // CCTV ke-1
  };

  try {
    // Fungsi bantu ambil data dari Spreadsheet (GAS)
    const fetchGAS = async (payload) => {
      console.log("4. Meminta data ke GAS:", JSON.stringify(payload));
      const resp = await fetch(GAS_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const gasText = await resp.text();
      console.log("5. Respon resmi dari GAS:", gasText); // CCTV ke-2
      return JSON.parse(gasText).data;
    };

    // Alur Logika Bot
    const namaTeknisi = await fetchGAS({ action: "check_whitelist", chatId });
    console.log("6. Teknisi yang terdeteksi:", namaTeknisi);

    if (!namaTeknisi) {
      await sendTG("Maaf, ID Telegram Anda belum terdaftar di whitelist (db_teknisi).");
      return res.status(200).send('OK');
    }

    if (update.message && text) {
      if (text === "/start") {
        const stoList = await fetchGAS({ action: "get_sto_list" });
        console.log("7. List STO didapat:", stoList);
        const buttons = stoList.map(sto => ([{ text: `📍 ${sto}`, callback_data: `sto_${sto}` }]));
        await sendTG("Silakan pilih lokasi STO tempat Anda bertugas saat ini:", { inline_keyboard: buttons });
        return res.status(200).send('OK');
      } 
      
      const userState = await fetchGAS({ action: "get_state", chatId });
      if (userState && userState.state === "WAITING_FOR_JOB_DESC") {
        await fetchGAS({ action: "input_job", nama: namaTeknisi, pekerjaan: text, sto: userState.sto, partner: userState.partner });
        await fetchGAS({ action: "clear_state", chatId });
        await sendTG(`🚀 Pekerjaan Berhasil Diinput!\n\nStatus tim berubah menjadi *Progress*.\nJika pekerjaan sudah selesai, silakan klik tombol selesai di bawah ini:`, { inline_keyboard: [[{ text: "✅ Selesai Progress", callback_data: "finish_current" }]] });
      }
    }

    if (update.callback_query) {
      if (callbackData.startsWith("sto_")) {
        const selectedSto = callbackData.replace("sto_", "");
        const idleTechs = await fetchGAS({ action: "get_idle_techs", namaTeknisi });
        const buttons = idleTechs.map(name => ([{ text: `👦 ${name}`, callback_data: `partner_${name}|${selectedSto}` }]));
        buttons.push([{ text: "🏃 Kerja Sendiri", callback_data: `partner_none|${selectedSto}` }]);
        await sendTG(`STO Terpilih: ${selectedSto}\n\nPilih rekan tim kamu:`, { inline_keyboard: buttons });
      }
      else if (callbackData.startsWith("partner_")) {
        const [partnerRaw, sto] = callbackData.replace("partner_", "").split("|");
        const partner = partnerRaw === "none" ? "" : partnerRaw;
        await fetchGAS({ action: "set_state", chatId, state: "WAITING_FOR_JOB_DESC", sto, partner });
        await sendTG(`Rekan Tim: ${partner || "Kerja Sendiri"}\n\nSilakan ketik detail beserta tiket / order dan uraian pekerjaan yang akan kamu lakukan sekarang:`);
      }
      else if (callbackData === "finish_current" || callbackData.startsWith("alert_finish_")) {
        const rowIdx = callbackData.startsWith("alert_finish_") ? parseInt(callbackData.replace("alert_finish_", "")) : null;
        const isSuccess = await fetchGAS({ action: "finish_job", namaTeknisi, rowIdx });
        if (isSuccess) {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chat_id: chatId, message_id: update.callback_query.message.message_id, reply_markup: { inline_keyboard: [] } })
          });
          await sendTG("✅ Status Pekerjaan Selesai! Status kembali ke *Idle* (Hijau) dan dicatat di spreadsheet.");
        } else await sendTG("Gagal memperbarui status. Pekerjaan mungkin sudah diselesaikan.");
      }
    }
    
    res.status(200).send('OK');
  } catch (err) {
    console.error("Terjadi Error Internal:", err);
    res.status(500).send(err.toString());
  }
};
