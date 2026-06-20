module.exports = async (req, res) => {
  const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL; 
  
  try {
    const resp = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: "get_dashboard" })
    });
    
    const result = await resp.json();
    
    // Set Header agar browser bisa membacanya dengan aman
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(result.data);
    
  } catch (err) {
    console.error("Error fetching dashboard:", err);
    res.status(500).json({ error: err.toString() });
  }
};
