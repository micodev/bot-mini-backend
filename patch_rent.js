const fs = require('fs');

const serverFile = '/Users/ibrahim/Desktop/bots/bot mini app backend/server.js';
let code = fs.readFileSync(serverFile, 'utf8');

const marketCategoriesStr = `const MARKET_CATEGORIES = ["Real Estate", "Vehicles", "Private Jets", "Jewelry", "Adult Toys", "Nightlife", "Sexy Clothing"];
const RENT_YIELD_PER_MINUTE = 0.0003;

async function getPendingRentExact(userId) {
  const account = await querySqlite('SELECT UnclaimedRent, LastRentUpdateUtc FROM Accounts WHERE UserId = ?', [userId]);
  if (!account) return 0;
  
  let lastRentUpdateMs = account.LastRentUpdateUtc ? new Date(account.LastRentUpdateUtc.endsWith('Z') ? account.LastRentUpdateUtc : account.LastRentUpdateUtc + 'Z').getTime() : 0;
  
  const sql = \`
    SELECT
      ai.PurchaseDate,
      i.Price,
      i.Category,
      mp.Multiplier
    FROM AccountItems ai
    JOIN Items i ON ai.ItemId = i.Id
    LEFT JOIN MarketPrices mp ON i.Category = mp.Category
    WHERE ai.AccountId = (SELECT AccountId FROM Accounts WHERE UserId = ?)
  \`;
  const inventory = await querySqliteAll(sql, [userId]);
  
  let totalRentGenerated = 0;
  const now = Date.now();
  
  for (const item of inventory) {
    if (!item.Category || !MARKET_CATEGORIES.includes(item.Category)) continue;
    
    let multiplier = item.Multiplier !== null ? item.Multiplier : 1.0;
    let currentMarketPrice = Math.round((item.Price * multiplier) / 1000.0) * 1000;
    
    let purchaseDateMs = new Date(item.PurchaseDate.endsWith('Z') ? item.PurchaseDate : item.PurchaseDate + 'Z').getTime();
    
    let startTimeMs = lastRentUpdateMs > purchaseDateMs ? lastRentUpdateMs : purchaseDateMs;
    
    let timeActiveMinutes = (now - startTimeMs) / (1000 * 60);
    
    if (timeActiveMinutes > 0) {
      totalRentGenerated += timeActiveMinutes * currentMarketPrice * RENT_YIELD_PER_MINUTE;
    }
  }
  
  let newRent = (account.UnclaimedRent || 0) + totalRentGenerated;
  
  const maxVaultLimit = 250000;
  if (newRent > maxVaultLimit) {
    newRent = maxVaultLimit;
  }
  
  return newRent;
}
`;

// Insert the helper function after getInventoryForAccount
if (!code.includes('async function getPendingRentExact(userId)')) {
  code = code.replace(
    /async function getInventoryForAccount[\s\S]*?\n\}/,
    `$&

${marketCategoriesStr}`
  );
}

// Update claim_rent socket event
const claimRentOld = `socket.on('claim_rent', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const row = await querySqlite('SELECT UnclaimedRent, LastRentUpdateUtc FROM Accounts WHERE UserId = ?', [userId]);
      let rentToClaim = 0;
      if (row) {
        const lastUpdateStr = row.LastRentUpdateUtc ? (row.LastRentUpdateUtc.endsWith('Z') ? row.LastRentUpdateUtc : row.LastRentUpdateUtc + 'Z') : new Date().toISOString();
        const lastUpdate = new Date(lastUpdateStr).getTime();
        const secondsPassed = Math.floor((Date.now() - lastUpdate) / 1000);
        const rentRatePerSecond = 1; // $1 per second base rate for demo
        rentToClaim = (row.UnclaimedRent || 0) + (secondsPassed > 0 ? secondsPassed * rentRatePerSecond : 0);
      } else {
        rentToClaim = playerData.unclaimedRent || 0;
      }

      if (rentToClaim <= 0) {
        return callback({ error: 'No rent to claim' });
      }

      const newBalance = (playerData.balance || 0) + rentToClaim;`;

const claimRentNew = `socket.on('claim_rent', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const exactRent = await getPendingRentExact(userId);
      const rentToClaim = Math.floor(exactRent);

      if (rentToClaim <= 0) {
        return callback({ error: 'No rent to claim' });
      }

      const newBalance = (playerData.balance || 0) + rentToClaim;`;

code = code.replace(claimRentOld, claimRentNew);

// Update setInterval
const setIntervalOld = `setInterval(async () => {
  const uniqueUsers = [...new Set(connectedUsers.values())];
  for (const userId of uniqueUsers) {
    try {
      const row = await querySqlite('SELECT UnclaimedRent, LastRentUpdateUtc FROM Accounts WHERE UserId = ?', [userId]);
      if (row) {
        const lastUpdateStr = row.LastRentUpdateUtc ? (row.LastRentUpdateUtc.endsWith('Z') ? row.LastRentUpdateUtc : row.LastRentUpdateUtc + 'Z') : new Date().toISOString();
        const lastUpdate = new Date(lastUpdateStr).getTime();
        const secondsPassed = Math.floor((Date.now() - lastUpdate) / 1000);
        const rentRatePerSecond = 1; // $1 per second base rate for demo
        let newRent = (row.UnclaimedRent || 0) + (secondsPassed > 0 ? secondsPassed * rentRatePerSecond : 0);
        
        io.to(\`user_\${userId}\`).emit('rent_update', { unclaimedRent: newRent });
      }
    } catch (err) { }
  }
}, 3000);`;

const setIntervalNew = `setInterval(async () => {
  const uniqueUsers = [...new Set(connectedUsers.values())];
  for (const userId of uniqueUsers) {
    try {
      const newRent = await getPendingRentExact(userId);
      io.to(\`user_\${userId}\`).emit('rent_update', { unclaimedRent: newRent });
    } catch (err) { console.error('Rent interval error:', err); }
  }
}, 3000);`;

code = code.replace(setIntervalOld, setIntervalNew);

fs.writeFileSync(serverFile, code);
console.log('Patched rent logic');
