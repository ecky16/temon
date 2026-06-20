module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL; 
  
  const update = req.body;
  const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
  const text = update.message?.text;
  const callbackData = update.callback_query?.data;

  if (!chatId) return res.status(200).send('OK');

  const sendTG = async (textMsg, keyboard = null) => {
    let payload = { chat_id: chatId, text: textMsg, parse_mode: "Markdown" };
    if (keyboard) payload.reply_markup = keyboard;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
  };

  try {
    const fetchGAS = async (payload) => {
      const resp = await fetch(GAS_WEBAPP_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      return JSON.parse(await resp.text()).data;
    };

    const namaTeknisi = await fetchGAS({ action: "check_whitelist", chatId });
    if (!namaTeknisi) {
      await sendTG("Maaf, ID Telegram Anda belum terdaftar di whitelist (db_teknisi).");
      return res.status(200).send('OK');
    }

    // 1. TANGKAP PESAN TEXT DARI USER
    if (update.message && text) {
      if (text === "/start") {
        // Cek apakah dia sedang terikat pekerjaan aktif sebelum nembak daftar STO
        const activeJob = await fetchGAS({ action: "get_active_job", namaTeknisi });
        
        if (activeJob) {
          if (activeJob.role === "utama") {
            const txt = `Anda saat ini berstatus sedang bekerja:\n\n🛠 *${activeJob.pekerjaan}*\n📍 *STO ${activeJob.sto}*\n👥 *Partner:* ${activeJob.partner || '-'}\n\nJika pekerjaan ini sudah selesai, silakan klik tombol di bawah.`;
            const kb = { inline_keyboard: [[{ text: "✅ Selesai Progress", callback_data: "finish_current" }]] };
            await sendTG(txt, kb);
          } else {
            // Skenario si B di-tag oleh si A
            const txt = `Anda saat ini telah *didaftarkan oleh ${activeJob.utama}* dalam 1 tim untuk pekerjaan:\n\n🛠 *${activeJob.pekerjaan}*\n📍 *STO ${activeJob.sto}*\n\nAnda tidak perlu melakukan input lagi. Namun, jika Anda saat ini berpisah tim dan akan mengerjakan order lain, silakan klik tombol di bawah ini:`;
            const kb = { inline_keyboard: [[{ text: "👋 Keluar dari Tim (Misah)", callback_data: "leave_team" }]] };
            await sendTG(txt, kb);
          }
          return res.status(200).send('OK'); // Hentikan agar tidak muncul list STO
        }

        // Kalau Idle, tampilkan STO
        const stoList = await fetchGAS({ action: "get_sto_list" });
        const buttons = stoList.map(sto => ([{ text: `📍 ${sto}`, callback_data: `sto_${sto}` }]));
        await sendTG("Silakan pilih lokasi STO tempat Anda bertugas saat ini:", { inline_keyboard: buttons });
        return res.status(200).send('OK');
      } 
      
      // Skenario ngetik uraian pekerjaan
      const userState = await fetchGAS({ action: "get_state", chatId });
      if (userState && userState.state === "WAITING_FOR_JOB_DESC") {
        await fetchGAS({ action: "input_job", nama: namaTeknisi, pekerjaan: text, sto: userState.sto, partner: userState.partner });
        await fetchGAS({ action: "clear_state", chatId });
        await sendTG(`🚀 Pekerjaan Berhasil Diinput!\n\nStatus tim berubah menjadi *Mengerjakan*.\nJika pekerjaan sudah selesai, silakan klik tombol selesai di bawah ini:`, { inline_keyboard: [[{ text: "✅ Selesai Progress", callback_data: "finish_current" }]] });
      }
    }

    // 2. TANGKAP TOMBOL INLINE
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
        await sendTG(`Rekan Tim: ${partner || "Kerja Sendiri"}\n\nSilakan ketik detail/uraian pekerjaan yang akan Anda lakukan sekarang:`);
      }
      // Skenario Si B klik tombol Keluar dari Tim
      else if (callbackData === "leave_team") {
        const result = await fetchGAS({ action: "leave_team", namaTeknisi });
        if (result && result.success) {
          // Hapus tombol agar tidak bisa diklik 2x
          await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chat_id: chatId, message_id: update.callback_query.message.message_id, reply_markup: { inline_keyboard: [] } })
          });
          
          await sendTG("✅ *Berhasil Keluar Tim.*\n\nStatus Anda sekarang *Idle*. Silakan ketik /start lagi untuk menginput pekerjaan baru Anda.");
          
          // Kirim notifikasi diam-diam ke si Teknisi Utama (Si A)
          if (result.tgIdUtama) {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ chat_id: result.tgIdUtama, text: `⚠️ *INFO TIM:*\nRekan tim Anda (*${namaTeknisi}*) telah keluar dari tim karena mengerjakan order lain.\n\nStatus Anda sekarang menjadi *Kerja Sendiri* untuk tiket:\n🛠 ${result.pekerjaan}`, parse_mode: "Markdown" })
            });
          }
        } else {
          await sendTG("Gagal keluar dari tim. Mungkin pekerjaan sudah diselesaikan.");
        }
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
