// index.js
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');

const STATE_FILE = '/tmp/last_inventory.json'; // Persistent storage on Render

async function checkInventory() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 1. Login to Loyverse Back Office
  await page.goto('https://backoffice.loyverse.com/login');
  await page.fill('input[name="email"]', process.env.LOYVERSE_EMAIL);
  await page.fill('input[name="password"]', process.env.LOYVERSE_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForNavigation();
  
  // 2. Navigate to Stock History
  await page.goto('https://backoffice.loyverse.com/inventory/stock_history');
  await page.waitForSelector('table'); // Wait for history table
  
  // 3. Extract latest entries
  const latestEntries = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(row => {
      const cells = row.querySelectorAll('td');
      return {
        timestamp: cells[0]?.innerText.trim(),
        item: cells[1]?.innerText.trim(),
        reason: cells[2]?.innerText.trim(),
        quantity: cells[3]?.innerText.trim(),
        location: cells[4]?.innerText.trim()
      };
    }).filter(entry => entry.item);
  });
  
  // 4. Load previous state & find NEW entries
  let previous = [];
  try { previous = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch (e) {}
  
  const newEntries = latestEntries.filter(
    entry => !previous.some(p => p.timestamp === entry.timestamp && p.item === entry.item)
  );
  
  // 5. Email new entries
  if (newEntries.length > 0) {
    await sendEmail(newEntries);
    console.log(`📧 Sent email with ${newEntries.length} new inventory changes`);
  } else {
    console.log('✅ No new inventory changes');
  }
  
  // 6. Save current state
  await fs.writeFile(STATE_FILE, JSON.stringify(latestEntries.slice(0, 20))); // Keep last 20
  
  await browser.close();
}

async function sendEmail(entries) {
  const transporter = nodemailer.createTransporter({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD // Use App Password, not account password
    }
  });
  
  const html = `
    <h2>📦 New Inventory Changes</h2>
    <table border="1" cellpadding="5" style="border-collapse: collapse;">
      <tr><th>Time</th><th>Item</th><th>Reason</th><th>Qty</th><th>Location</th></tr>
      ${entries.map(e => `
        <tr>
          <td>${e.timestamp}</td>
          <td><strong>${e.item}</strong></td>
          <td>${e.reason}</td>
          <td>${e.quantity}</td>
          <td>${e.location}</td>
        </tr>
      `).join('')}
    </table>
  `;
  
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.ALERT_EMAIL,
    subject: `📦 ${entries.length} New Inventory Changes`,
    html
  });
}

checkInventory().catch(console.error);
