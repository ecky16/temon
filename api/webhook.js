
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL; // URL deployment GAS kamu
  
  const update = req.body;
  const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
  const text = update.message?.text;
  const callbackData = update.callback_query?.data;

  // Fungsi bantu untuk interaksi ke GAS
  const fetchGAS = async (payload) => {
    const resp = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return (await resp.json()).data;
  };

  // Fungsi bantu kirim pesan Telegram
  const sendTG = async (textMsg, keyboard = null) => {
    let payload = { chat_id: chatId, text: textMsg, parse_mode: "Markdown" };
    if (keyboard) payload.reply_markup = keyboard;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
  };

  // 1. Cek Whitelist dari GAS
  const namaTeknisi = await fetchGAS({ action: "check_whitelist", chatId });
  if (!namaTeknisi) {
    await sendTG("Maaf, ID Telegram Anda belum terdaftar di whitelist.");
    return res.status(200).send('OK');
  }

  // 2. Handle Message Text
  if (update.message) {
    if (text === "/start") {
      const stoList = await fetchGAS({ action: "get_sto_list" });
      const buttons = stoList.map(sto => ([{ text: `📍 ${sto}`, callback_data: `sto_${sto}` }]));
      await sendTG("Silakan pilih lokasi STO tempat Anda bertugas saat ini:", { inline_keyboard: buttons });
    } 
    // Jika inputan teks biasa (deskripsi pekerjaan) - diasumsikan state manajemen menggunakan database/cache external jika diperlukan
    // Di Vercel serverless, karena stateless, kamu bisa menggunakan Supabase/Redis kecil, 
    // atau sekadar menambahkan parameter di callback agar tidak perlu simpan state panjang.
  }

  // 3. Handle Callback Query (Tombol Inline)
  if (update.callback_query) {
    if (callbackData.startsWith("sto_")) {
      const selectedSto = callbackData.replace("sto_", "");
      const idleTechs = await fetchGAS({ action: "get_idle_techs", namaTeknisi });
      const buttons = idleTechs.map(name => ([{ text: `👦 ${name}`, callback_data: `partner_${name}|${selectedSto}` }]));
      buttons.push([{ text: "🏃 Kerja Sendiri", callback_data: `partner_none|${selectedSto}` }]);
      
      await sendTG(`STO Terpilih: ${selectedSto}\n\nPilih rekan tim kamu:`, { inline_keyboard: buttons });
    }
    else if (callbackData.startsWith("partner_")) {
      // Parse data partner & STO, karena fungsi API stateless
      const [partnerRaw, sto] = callbackData.replace("partner_", "").split("|");
      const partner = partnerRaw === "none" ? "" : partnerRaw;
      
      // Catat kerjaan langsung dengan teks bawaan atau minta balasan dengan format tertentu
      await fetchGAS({ 
        action: "input_job", 
        nama: namaTeknisi, 
        pekerjaan: "Pekerjaan Harian", // Bisa dikembangkan dengan command Telegram
        sto: sto, 
        partner: partner 
      });
      await sendTG("🚀 Pekerjaan Berhasil Diinput! Status berubah menjadi *Mengerjakan*.");
    }
    else if (callbackData === "finish_current" || callbackData.startsWith("alert_finish_")) {
      const rowIdx = callbackData.startsWith("alert_finish_") ? parseInt(callbackData.replace("alert_finish_", "")) : null;
      const isSuccess = await fetchGAS({ action: "finish_job", namaTeknisi, rowIdx });
      
      if (isSuccess) await sendTG("✅ Status Pekerjaan Selesai! Status kembali ke *Idle*.");
      else await sendTG("Gagal memperbarui status.");
    }
  }

  res.status(200).send('OK');
}
