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
    // FIX: Tambahkan redirect 'follow' dan Try-Catch agar tidak crash
    const fetchGAS = async (payload) => {
      try {
        const resp = await fetch(GAS_WEBAPP_URL, {
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify(payload),
          redirect: 'follow' 
        });
        const textResp = await resp.text();
        const parsed = JSON.parse(textResp);
        return parsed ? parsed.data : null;
      } catch (err) {
        console.error("Gagal Fetch ke GAS:", err);
        return null;
      }
    };

    const namaTeknisi = await fetchGAS({ action: "check_whitelist", chatId });
    if (!namaTeknisi) {
      await sendTG("Maaf, ID Telegram kamu belum terdaftar di whitelist (db_teknisi).");
      return res.status(200).send('OK');
    }

    // 0. TANGKAP LIVE LOCATION DARI TELEGRAM
    const locationObj = update.message?.location || update.edited_message?.location;
    if (locationObj) {
      const lat = locationObj.latitude;
      const lng = locationObj.longitude;
      await fetchGAS({ action: "update_live_location", chatId, lat, lng });
      
      if (update.message?.location) {
        await sendTG("✅ *Live Location Berhasil Terdeteksi!*\n\nStatus lokasi Anda aktif selama 8 jam. Silakan ketik /start untuk memilih STO dan pekerjaan.");
      }
      return res.status(200).send('OK');
    }

    // 1. TANGKAP PESAN TEXT DARI USER
    if (update.message && text) {
      if (text === "/start") {
        
        // FIX BUNDLING: Hanya 1x request ke GAS untuk ngambil semua info awal
        const startData = await fetchGAS({ action: "init_start", chatId, namaTeknisi });
        
        if (startData && startData.activeJob) {
          const aj = startData.activeJob;
          if (aj.role === "utama") {
            const txt = `Kamu saat ini berstatus sedang bekerja:\n\n🛠 *${aj.pekerjaan}*\n📍 *STO ${aj.sto}*\n👥 *Partner:* ${aj.partner || '-'}\n\nJika pekerjaan ini sudah selesai, silakan klik tombol di bawah.`;
            await sendTG(txt, { inline_keyboard: [[{ text: "✅ Selesai Progress", callback_data: "finish_current" }]] });
          } else {
            const txt = `Kamu saat ini telah *didaftarkan oleh ${aj.utama}* dalam 1 tim untuk pekerjaan:\n\n🛠 *${aj.pekerjaan}*\n📍 *STO ${aj.sto}*\n\nKamu tidak perlu melakukan input lagi.\nNamun, jika kamu saat ini berpisah tim dan akan mengerjakan order lain, silakan klik tombol di bawah ini:`;
            await sendTG(txt, { inline_keyboard: [[{ text: "👋 Keluar dari Tim (Misah)", callback_data: "leave_team" }]] });
          }
          return res.status(200).send('OK'); 
        }

        if (!startData || !startData.isLiveActive) {
          const alertLoc = `⚠️ *LIVE LOCATION TERDETEKSI BELUM AKTIF!*\n\nUntuk memastikan pergerakan tim terpantau di Dashboard Peta, Anda wajib mengaktifkan Live Location Telegram terlebih dahulu:\n\n1. Klik ikon **Lampiran (📎)** di Telegram.\n2. Pilih menu **Lokasi (Location)**.\n3. Pilih **"Bagikan Lokasi Langsung Saya..." (Share My Live Location...)**.\n4. Setel waktunya ke **8 Jam**.\n\n*Setelah Live Location aktif, silakan ketik /start lagi.*`;
          await sendTG(alertLoc);
          return res.status(200).send('OK');
        }

        if (!startData.stoList || startData.stoList.length === 0) {
           await sendTG("⚠️ Maaf, tidak ada STO yang ditemukan untuk Service Area kamu. Pastikan Service Area kamu sudah terisi dengan benar di spreadsheet.");
           return res.status(200).send('OK');
        }

        const stoButtonsFlat = startData.stoList.map(sto => ({ text: `📍 ${sto}`, callback_data: `sto_${sto}` }));
        const buttons = [];
        for (let i = 0; i < stoButtonsFlat.length; i += 3) {
            buttons.push(stoButtonsFlat.slice(i, i + 3));
        }
        
        await sendTG("Silakan pilih lokasi STO tempat kamu bertugas saat ini:", { inline_keyboard: buttons });
        return res.status(200).send('OK');
      }
      
      const userState = await fetchGAS({ action: "get_state", chatId });
      if (userState && userState.state === "WAITING_FOR_JOB_DESC") {
        await fetchGAS({ action: "input_job", nama: namaTeknisi, pekerjaan: text, sto: userState.sto, partner: userState.partner, chatId: chatId });
        await sendTG(`🚀 Pekerjaan Berhasil Diinput!\n\nStatus tim berubah menjadi *Progress*.\nJika pekerjaan sudah selesai, silakan klik tombol selesai di bawah ini:`, { inline_keyboard: [[{ text: "✅ Selesai Progress", callback_data: "finish_current" }]] });
      }
    }

    // 2. TANGKAP TOMBOL INLINE
    if (update.callback_query) {
      
      // FIX: Matikan efek loading tombol Telegram dengan answerCallbackQuery
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: update.callback_query.id })
      }).catch(err => console.error(err));

      if (callbackData.startsWith("sto_")) {
        const selectedSto = callbackData.replace("sto_", "");
        const idleTechs = await fetchGAS({ action: "get_idle_techs", namaTeknisi });
        
        const partnerButtonsFlat = idleTechs.map(name => ({ text: `👦 ${name}`, callback_data: `partner_${name}|${selectedSto}` }));
        const buttons = [];
        for (let i = 0; i < partnerButtonsFlat.length; i += 2) {
          buttons.push(partnerButtonsFlat.slice(i, i + 2));
        }
        buttons.push([{ text: "🏃 Kerja Sendiri", callback_data: `partner_none|${selectedSto}` }]);
        
        await sendTG(`STO Terpilih: ${selectedSto}\n\nPilih rekan tim kamu:`, { inline_keyboard: buttons });
      }
      else if (callbackData.startsWith("partner_")) {
        const [partnerRaw, sto] = callbackData.replace("partner_", "").split("|");
        const partner = partnerRaw === "none" ? "" : partnerRaw;
        await fetchGAS({ action: "set_state", chatId, state: "WAITING_FOR_JOB_DESC", sto, partner });
        await sendTG(`Rekan Tim: ${partner || "Kerja Sendiri"}\n\nSilakan ketik no tiket/ order dan uraian pekerjaan yang akan kamu lakukan sekarang:`);
      }
      else if (callbackData === "leave_team") {
        const result = await fetchGAS({ action: "leave_team", namaTeknisi });
        if (result && result.success) {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chat_id: chatId, message_id: update.callback_query.message.message_id, reply_markup: { inline_keyboard: [] } })
          });
          await sendTG("✅ *Berhasil Keluar Tim.*\n\nStatus kamu sekarang *Idle*. Silakan ketik /start lagi untuk menginput pekerjaan baru kamu.");
          if (result.tgIdUtama) {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ chat_id: result.tgIdUtama, text: `⚠️ *INFO TIM:*\nRekan tim kamu (*${namaTeknisi}*) telah keluar dari tim karena mengerjakan order lain.\n\nStatus kamu sekarang menjadi *Kerja Sendiri* untuk tiket:\n🛠 ${result.pekerjaan}`, parse_mode: "Markdown" })
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
    
    return res.status(200).send('OK');
  } catch (err) {
    console.error("Terjadi Error Internal:", err);
    return res.status(500).send(err.toString());
  }
};
