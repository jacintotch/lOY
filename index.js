const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

// Initialize PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function main() {
  console.log('🚀 Starting Loyverse Inventory Monitor...');
  
  try {
    await checkInventory();
    console.log('✅ Done!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    await pool.end();
    process.exit(1);
  }
}

async function checkInventory() {
  // Initialize database table
  await initDatabase();
  
  // Launch browser
  console.log('🌐 Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    // Login to Loyverse
    console.log('🔐 Logging into Loyverse...');
    await page.goto('https://backoffice.loyverse.com/login', { 
      waitUntil: 'networkidle',
      timeout: 15000 
    });
    
    await page.fill('input[name="email"]', process.env.LOYVERSE_EMAIL);
    await page.fill('input[name="password"]', process.env.LOYVERSE_PASSWORD);
    await page.click('button[type="submit"]');
    
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
    
    // Check if login succeeded
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      throw new Error('Login failed - check credentials');
    }
    console.log('✅ Login successful');
    
    // Navigate to Stock History
    console.log('📊 Fetching stock history...');
    await page.goto('https://backoffice.loyverse.com/inventory/stock_history', { 
      waitUntil: 'networkidle',
      timeout: 15000 
    });
    
    // Wait for table to load
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Extract table data
    const latestEntries = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return null;
        
        return {
          timestamp: cells[0]?.innerText.trim(),
          item: cells[1]?.innerText.trim(),
          reason: cells[2]?.innerText.trim(),
          quantity: cells[3]?.innerText.trim(),
          location: cells[4]?.innerText.trim()
        };
      }).filter(entry => entry && entry.item && entry.timestamp);
    });
    
    console.log(`📋 Found ${latestEntries.length} inventory entries`);
    
    // Load previous state from database
    const previous = await getPreviousEntries();
    console.log(`💾 Loaded ${previous.length} previous entries from database`);
    
    // Find new entries
    const newEntries = latestEntries.filter(entry => 
      !previous.some(p => p.timestamp === entry.timestamp && p.item === entry.item)
    );
    
    console.log(`🆕 Found ${newEntries.length} new entries`);
    
    // Send email if there are new entries
    if (newEntries.length > 0) {
      console.log('📧 Sending email...');
      await sendEmail(newEntries);
      console.log('✅ Email sent successfully');
      
      // Save new entries to database
      await saveState(newEntries);
      console.log(`💾 Saved ${newEntries.length} new entries to database`);
    } else {
      console.log('ℹ️ No new inventory changes');
    }
    
  } finally {
    await browser.close();
    await pool.end();
    console.log('👋 Browser and database connection closed');
  }
}

// Initialize database table
async function initDatabase() {
  console.log('🗄️ Initializing database...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_state (
      id SERIAL PRIMARY KEY,
      timestamp TEXT NOT NULL,
      item TEXT NOT NULL,
      reason TEXT,
      quantity TEXT,
      location TEXT,
      saved_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  // Create index for faster lookups
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_inventory_timestamp_item 
    ON inventory_state(timestamp, item)
  `);
  console.log('✅ Database initialized');
}

// Get previous entries from database
async function getPreviousEntries() {
  const res = await pool.query(`
    SELECT timestamp, item, reason, quantity, location 
    FROM inventory_state 
    ORDER BY saved_at DESC 
    LIMIT 100
  `);
  return res.rows;
}

// Save new entries to database
async function saveState(entries) {
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO inventory_state (timestamp, item, reason, quantity, location) 
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.timestamp, entry.item, entry.reason, entry.quantity, entry.location]
    );
  }
}

// Send email notification
async function sendEmail(entries) {
  const transporter = nodemailer.createTransporter({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  
  // Test connection
  await transporter.verify();
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
        .container { background-color: white; padding: 30px; border-radius: 10px; max-width: 800px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h2 { color: #2c3e50; margin-top: 0; }
        .summary { background-color: #e3f2fd; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .summary strong { color: #1976d2; font-size: 24px; }
        table { border-collapse: collapse; width: 100%; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background-color: #3498db; color: white; font-weight: 600; }
        tr:nth-child(even) { background-color: #f2f2f2; }
        tr:hover { background-color: #e3f2fd; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #7f8c8d; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>📦 New Loyverse Inventory Changes</h2>
        
        <div class="summary">
          <strong>${entries.length}</strong> new inventory change${entries.length > 1 ? 's' : ''} detected
        </div>
        
        <table>
          <tr>
            <th>🕗 Time</th>
            <th>📦 Item</th>
            <th>📝 Reason</th>
            <th>🔢 Quantity</th>
            <th>📍 Location</th>
          </tr>
          ${entries.map(e => `
            <tr>
              <td><strong>${e.timestamp}</strong></td>
              <td>${e.item}</td>
              <td>${e.reason}</td>
              <td>${e.quantity}</td>
              <td>${e.location}</td>
            </tr>
          `).join('')}
        </table>
        
        <div class="footer">
          <p>This is an automated notification from your Loyverse Inventory Monitor.</p>
          <p>⏰ Checked at: ${new Date().toLocaleString()}</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  const text = `LOYVERSE INVENTORY ALERT\n\n` + 
    `New Changes Detected: ${entries.length}\n\n` +
    entries.map((e, i) => 
      `${i + 1}. ${e.timestamp} | ${e.item} | ${e.reason} | ${e
