import 'dotenv/config'
import express from 'express'
import fs from 'fs/promises'
import fsSync from 'fs'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'
import http from 'http'
import { Server } from 'socket.io'
import { createClient } from 'redis'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const PORT = process.env.PORT || 3000
const dbDir = process.env.DB_DIR || path.join(__dirname, 'db')
const jsonDir = process.env.JSON_DIR || (process.env.DB_DIR ? path.join(dbDir, 'Data') : dbDir)
const usersDbPath = path.join(dbDir, 'users.db')
const usersDb = new sqlite3.Database(usersDbPath, sqlite3.OPEN_READWRITE, (err) => {
  if (err) {
    console.error('Unable to open users.db:', err)
  } else {
    console.log('Connected to users.db')
  }
})

function querySqlite(sql, params = []) {
  return new Promise((resolve, reject) => {
    usersDb.get(sql, params, (err, row) => {
      if (err) return reject(err)
      resolve(row)
    })
  })
}

function querySqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    usersDb.all(sql, params, (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

function querySqliteRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    usersDb.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve(this)
    })
  })
}

app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

async function loadDbFile(filename) {
  const filePath = path.join(jsonDir, filename)
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

function getJobByLevel(jobs, level) {
  return jobs.find(job => job.level === level) || jobs[0]
}

function getTierDisplay(tier) {
  switch(tier) {
    case 0: return "👑 Emperor";
    case 1: return "💎 King";
    case 2: return "🥈 Prince";
    case 3: return "🥉 Duke";
    case 4: return "🎖️ Baron";
    case 5: return "🔰 Commoner";
    default: return "🔰 Commoner";
  }
}

async function getPlayerRankAndTier(userId) {
  if (String(userId) === '622676944') {
    return { tier: 0, rank: 1 };
  }

  const sql = `
    WITH UserNetWorths AS (
        SELECT a.UserId, 
               a.Balance + COALESCE((
                   SELECT SUM(CAST(ROUND(i.Price * COALESCE(mp.Multiplier, 1.0) / 1000.0) AS INTEGER) * 1000)
                   FROM AccountItems ai 
                   JOIN Items i ON ai.ItemId = i.Id 
                   LEFT JOIN MarketPrices mp ON i.Category = mp.Category 
                   WHERE ai.AccountId = a.AccountId
               ), 0) as NetWorth
        FROM Accounts a
        WHERE a.UserId != 622676944
    )
    SELECT 
        (SELECT COUNT(*) FROM UserNetWorths) AS total,
        (SELECT COUNT(*) FROM UserNetWorths WHERE NetWorth < (SELECT NetWorth FROM UserNetWorths WHERE UserId = ?)) AS strictLess,
        (SELECT COUNT(*) FROM UserNetWorths WHERE NetWorth = (SELECT NetWorth FROM UserNetWorths WHERE UserId = ?)) AS equal,
        (SELECT COUNT(*) FROM UserNetWorths WHERE NetWorth > (SELECT NetWorth FROM UserNetWorths WHERE UserId = ?)) AS strictGreater
  `;

  try {
    const row = await querySqlite(sql, [userId, userId, userId]);
    if (!row || row.total === 0) {
      return { tier: 5, rank: 1 };
    }
    
    const total = row.total;
    const strictLess = row.strictLess;
    const equal = row.equal;
    const strictGreater = row.strictGreater;

    // Tie-breaking logic: rank the users with same balance in the middle of their group
    const percentile = (strictLess + 0.5 * equal) / total;
    
    let tier = 5;
    if (percentile >= 0.95) tier = 1;
    else if (percentile >= 0.85) tier = 2;
    else if (percentile >= 0.70) tier = 3;
    else if (percentile >= 0.50) tier = 4;

    const rank = strictGreater + 1; // 1-based rank

    return { tier, rank };
  } catch (err) {
    console.error("Failed to get rank and tier:", err);
    return { tier: 5, rank: -1 };
  }
}

async function consumeEnergy(userId, amount) {
  const account = await querySqlite('SELECT Energy, LastEnergyRegenUtc FROM Accounts WHERE UserId = ?', [userId]);
  if (!account) return { success: false, error: 'Player not found' };

  let currentEnergy = account.Energy ?? 20;
  let lastRegenUtc = account.LastEnergyRegenUtc;
  const maxEnergy = 20;
  const regenPerHour = 5;

  let newRegenTime = lastRegenUtc ? new Date(lastRegenUtc.endsWith('Z') ? lastRegenUtc : lastRegenUtc + 'Z') : new Date();

  if (currentEnergy < maxEnergy && lastRegenUtc) {
    const lastTime = newRegenTime.getTime();
    const now = Date.now();
    const diffMs = now - lastTime;
    if (diffMs > 0) {
      const elapsedHours = diffMs / (1000 * 60 * 60);
      const energyToAdd = Math.floor(elapsedHours * regenPerHour);
      if (energyToAdd > 0) {
        currentEnergy = Math.min(maxEnergy, currentEnergy + energyToAdd);
        const minutesPerEnergy = 60.0 / regenPerHour;
        newRegenTime = new Date(lastTime + (energyToAdd * minutesPerEnergy * 60 * 1000));
      }
    }
  } else if (currentEnergy >= maxEnergy) {
    newRegenTime = new Date();
  }

  if (currentEnergy < amount) {
    return { success: false, error: 'Not enough energy', currentEnergy };
  }

  const finalEnergy = currentEnergy - amount;
  const newRegenTimeStr = newRegenTime.toISOString().replace('T', ' ').substring(0, 19);

  await querySqliteRun(
    'UPDATE Accounts SET Energy = ?, LastEnergyRegenUtc = ? WHERE UserId = ?',
    [finalEnergy, newRegenTimeStr, userId]
  );

  return { success: true, finalEnergy, newRegenTimeStr };
}

function buildPlayerInfo(jobs, treasures, playerData = null) {
  const defaultPlayer = {
    id: 'demo-player-1',
    name: 'Demo Player',
    username: 'guest',
    balance: 1000,
    accountNumber: null,
    thief: false,
    cardTypeId: null,
    cardTypeName: null,
    jobLevel: 1,
    shieldEndTimeUtc: null,
    nextSalaryClaimDate: new Date(Date.now() - 1000).toISOString(),
    lastSalaryClaimUtc: null,
    lastTreasureHuntUtc: null,
    lastWheelSpinUtc: null,
    lastInvestUtc: null,
    lastCoinFlipUtc: null,
    lastStealUtc: null,
    lastRaidUtc: null,
    lastBribeUtc: null,
    lastBurgerUtc: null,
    lastRentUpdateUtc: null,
    unclaimedRent: 0,
    lastWealthTaxUtc: null,
    slotTempBalance: 0,
    createdAt: null,
    lastSeen: null,
    inventory: [],
  }

  const source = playerData ?? defaultPlayer
  const job = getJobByLevel(jobs, source.jobLevel)
  const inventory = Array.isArray(source.inventory) ? source.inventory : []
  const treasureValue = inventory.reduce((sum, item) => sum + (item.value || 0), 0)
  const shields = source.shieldEndTimeUtc
    ? (new Date(source.shieldEndTimeUtc) > new Date() ? 1 : 0)
    : 0

  return {
    id: source.id,
    name: source.name,
    username: source.username,
    balance: source.balance,
    accountNumber: source.accountNumber,
    thief: source.thief,
    cardTypeId: source.cardTypeId,
    cardTypeName: source.cardTypeName,
    jobLevel: job.level,
    jobTitle: job.title,
    jobSalary: job.salary,
    tier: source.tier ?? 5,
    tierName: source.tierName ?? "🔰 Commoner",
    rank: source.rank ?? -1,
    shields,
    shieldEndTimeUtc: source.shieldEndTimeUtc,
    nextSalaryClaimDate: source.nextSalaryClaimDate,
    lastSalaryClaimUtc: source.lastSalaryClaimUtc,
    lastTreasureHuntUtc: source.lastTreasureHuntUtc,
    lastWheelSpinUtc: source.lastWheelSpinUtc,
    lastInvestUtc: source.lastInvestUtc,
    lastCoinFlipUtc: source.lastCoinFlipUtc,
    lastStealUtc: source.lastStealUtc,
    lastRaidUtc: source.lastRaidUtc,
    lastBribeUtc: source.lastBribeUtc,
    lastBurgerUtc: source.lastBurgerUtc,
    lastRentUpdateUtc: source.lastRentUpdateUtc,
    unclaimedRent: source.unclaimedRent,
    lastWealthTaxUtc: source.lastWealthTaxUtc,
    slotTempBalance: source.slotTempBalance ?? 0,
    energy: source.energy ?? 20,
    lastEnergyRegenUtc: source.lastEnergyRegenUtc,
    createdAt: source.createdAt,
    lastSeen: source.lastSeen,
    inventory,
    treasureValue,
  }
}

async function getUserProfileFromDb(userId) {
  const sql = `
    SELECT
      Accounts.AccountId,
      Accounts.UserId,
      Accounts.Balance,
      Accounts.AccountNumber,
      Accounts.Thief,
      Accounts.CardTypeId,
      CardTypes.Name AS CardTypeName,
      Accounts.JobLevel,
      Accounts.LastSalaryClaimUtc,
      Accounts.LastTreasureHuntUtc,
      Accounts.LastWheelSpinUtc,
      Accounts.LastInvestUtc,
      Accounts.LastCoinFlipUtc,
      Accounts.LastStealUtc,
      Accounts.LastRaidUtc,
      Accounts.LastBribeUtc,
      Accounts.ShieldEndTimeUtc,
      Accounts.LastBurgerUtc,
      Accounts.LastRentUpdateUtc,
      Accounts.UnclaimedRent,
      Accounts.LastWealthTaxUtc,
      Accounts.SlotTempBalance,
      Accounts.Energy,
      Accounts.LastEnergyRegenUtc,
      Users.FirstName,
      Users.LastName,
      Users.Username,
      Users.AccessHash,
      Users.CreatedAt,
      Users.LastSeen
    FROM Accounts
    JOIN Users ON Accounts.UserId = Users.UserId
    LEFT JOIN CardTypes ON Accounts.CardTypeId = CardTypes.Id
    WHERE Accounts.UserId = ?
  `
  const row = await querySqlite(sql, [userId])
  if (!row) return null

  const salaryCooldownMs = 0.50 * 60 * 60 * 1000
  let nextSalaryClaimDate = new Date(Date.now() - 1000).toISOString()
  if (row.LastSalaryClaimUtc) {
    const lastClaimStr = row.LastSalaryClaimUtc.endsWith('Z') 
      ? row.LastSalaryClaimUtc 
      : row.LastSalaryClaimUtc + 'Z'
    nextSalaryClaimDate = new Date(new Date(lastClaimStr).getTime() + salaryCooldownMs).toISOString()
  }

  return {
    accountId: row.AccountId,
    id: String(row.UserId),
    username: row.Username || `user-${row.UserId}`,
    name: [row.FirstName, row.LastName].filter(Boolean).join(' ') || row.Username || `user-${row.UserId}`,
    accessHash: row.AccessHash,
    accountNumber: row.AccountNumber,
    balance: row.Balance,
    thief: Boolean(row.Thief),
    cardTypeId: row.CardTypeId,
    cardTypeName: row.CardTypeName,
    jobLevel: row.JobLevel,
    shieldEndTimeUtc: row.ShieldEndTimeUtc,
    nextSalaryClaimDate: nextSalaryClaimDate,
    lastSalaryClaimUtc: row.LastSalaryClaimUtc,
    lastTreasureHuntUtc: row.LastTreasureHuntUtc,
    lastWheelSpinUtc: row.LastWheelSpinUtc,
    lastInvestUtc: row.LastInvestUtc,
    lastCoinFlipUtc: row.LastCoinFlipUtc,
    lastStealUtc: row.LastStealUtc,
    lastRaidUtc: row.LastRaidUtc,
    lastBribeUtc: row.LastBribeUtc,
    lastBurgerUtc: row.LastBurgerUtc,
    lastRentUpdateUtc: row.LastRentUpdateUtc,
    unclaimedRent: row.UnclaimedRent,
    lastWealthTaxUtc: row.LastWealthTaxUtc,
    slotTempBalance: row.SlotTempBalance || 0,
    energy: row.Energy ?? 20,
    lastEnergyRegenUtc: row.LastEnergyRegenUtc,
    createdAt: row.CreatedAt,
    lastSeen: row.LastSeen,
    inventory: [],
  }
}

async function getInventoryForAccount(accountId) {
  const sql = `
    SELECT
      AccountItems.Id AS accountItemId,
      AccountItems.PurchasePrice,
      AccountItems.PurchaseDate,
      Items.Id AS itemId,
      Items.ItemName,
      Items.Price,
      Items.Rarity,
      Items.Category
    FROM AccountItems
    JOIN Items ON AccountItems.ItemId = Items.Id
    WHERE AccountItems.AccountId = ?
  `
  const rows = await querySqliteAll(sql, [accountId])
  return rows.map(row => ({
    accountItemId: row.accountItemId,
    itemId: row.itemId,
    name: row.ItemName,
    price: row.Price,
    purchasePrice: row.PurchasePrice,
    purchaseDate: row.PurchaseDate,
    rarity: row.Rarity,
    category: row.Category,
    value: row.Price,
  }))
}

const MARKET_CATEGORIES = ["Real Estate", "Vehicles", "Private Jets", "Jewelry", "Adult Toys", "Nightlife", "Sexy Clothing"];
const RENT_YIELD_PER_MINUTE = parseFloat(process.env.RENT_YIELD_PER_MINUTE || 0.00005);
const WEALTH_TAX_PERCENTAGE = parseFloat(process.env.WEALTH_TAX_PERCENTAGE || 0.02);
const WEALTH_TAX_COOLDOWN_HOURS = parseFloat(process.env.WEALTH_TAX_COOLDOWN_HOURS || 24);

async function updatePendingRentAsync(userId) {
  const account = await querySqlite('SELECT UnclaimedRent, LastRentUpdateUtc, Balance, AccountId FROM Accounts WHERE UserId = ?', [userId]);
  if (!account) return { unclaimedRent: 0, balance: 0 };
  
  let lastRentUpdateMs = account.LastRentUpdateUtc ? new Date(account.LastRentUpdateUtc.endsWith('Z') ? account.LastRentUpdateUtc : account.LastRentUpdateUtc + 'Z').getTime() : 0;
  
  const sql = `
    SELECT
      ai.PurchaseDate,
      i.Price,
      i.Category,
      mp.Multiplier
    FROM AccountItems ai
    JOIN Items i ON ai.ItemId = i.Id
    LEFT JOIN MarketPrices mp ON i.Category = mp.Category
    WHERE ai.AccountId = ?
  `;
  const inventory = await querySqliteAll(sql, [account.AccountId]);
  
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
  
  let claimableRent = Math.floor(totalRentGenerated);
  if (claimableRent > 0) {
    const maxVaultLimit = 1000000;
    let allowedToAdd = claimableRent;
    if ((account.Balance || 0) >= 1000000) {
      if ((account.UnclaimedRent || 0) + allowedToAdd > maxVaultLimit) {
        allowedToAdd = maxVaultLimit - (account.UnclaimedRent || 0);
      }
    }
    
    if (allowedToAdd > 0) {
      await querySqliteRun(
        'UPDATE Accounts SET UnclaimedRent = UnclaimedRent + ?, Balance = CASE WHEN UserId = 622676944 THEN MAX(1000000000, Balance + ?) ELSE Balance + ? END WHERE UserId = ?',
        [allowedToAdd, allowedToAdd, allowedToAdd, userId]
      );
    }
    
    const nowUtc = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await querySqliteRun(
      'UPDATE Accounts SET LastRentUpdateUtc = ? WHERE UserId = ?',
      [nowUtc, userId]
    );
  }
  
  const newAccount = await querySqlite('SELECT UnclaimedRent, Balance FROM Accounts WHERE UserId = ?', [userId]);
  return newAccount ? { unclaimedRent: newAccount.UnclaimedRent, balance: newAccount.Balance } : { unclaimedRent: 0, balance: 0 };
}

app.get('/api/player', async (req, res) => {
  try {
    const jobsData = await loadDbFile('jobs.json')
    const treasuresData = await loadDbFile('treasures.json')
    const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures)
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info:', error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.get('/api/player/:id', async (req, res) => {
  try {
    await updatePendingRentAsync(req.params.id)
    const jobsData = await loadDbFile('jobs.json')
    const treasuresData = await loadDbFile('treasures.json')
    const playerData = await getUserProfileFromDb(req.params.id)
    if (!playerData) {
      return res.status(404).json({ error: 'Player not found' })
    }
    const inventory = await getInventoryForAccount(playerData.accountId)
    playerData.inventory = inventory
    
    const rankTierInfo = await getPlayerRankAndTier(req.params.id)
    playerData.tier = rankTierInfo.tier
    playerData.tierName = getTierDisplay(rankTierInfo.tier)
    playerData.rank = rankTierInfo.rank

    const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures, playerData)
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info for id', req.params.id, error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.get('/api/jobs', async (req, res) => {
  try {
    const jobsData = await loadDbFile('jobs.json')
    return res.json(jobsData.jobs)
  } catch (error) {
    console.error('Failed to load jobs:', error)
    return res.status(500).json({ error: 'Failed to load jobs' })
  }
})

app.get('/api/market', async (req, res) => {
  try {
    const rows = await querySqliteAll('SELECT Category, Multiplier, Trend, LastUpdated FROM MarketPrices')
    const marketData = {}
    rows.forEach(row => {
      marketData[row.Category] = {
        multiplier: row.Multiplier,
        trend: row.Trend,
        lastUpdated: row.LastUpdated
      }
    })
    return res.json(marketData)
  } catch (error) {
    console.error('Failed to load market:', error)
    return res.status(500).json({ error: 'Failed to load market' })
  }
})

app.post('/api/player/:id/salary', async (req, res) => {
  try {
    const userId = req.params.id
    const playerData = await getUserProfileFromDb(userId)
    if (!playerData) return res.status(404).json({ error: 'Player not found' })

    const jobsData = await loadDbFile('jobs.json')
    const job = getJobByLevel(jobsData.jobs, playerData.jobLevel)
    
    // Cooldown check (30 minutes)
    const cooldownMs = 0.50 * 60 * 60 * 1000
    const now = new Date()
    if (playerData.lastSalaryClaimUtc) {
      // The DB date is typically stored as UTC without 'Z' at the end, so we might need to append it for proper parsing
      const lastClaimStr = playerData.lastSalaryClaimUtc.endsWith('Z') 
        ? playerData.lastSalaryClaimUtc 
        : playerData.lastSalaryClaimUtc + 'Z'
      const lastClaim = new Date(lastClaimStr)
      
      if (now - lastClaim < cooldownMs) {
        return res.status(400).json({ 
          error: 'Salary on cooldown', 
          nextClaimDate: new Date(lastClaim.getTime() + cooldownMs).toISOString() 
        })
      }
    }

    const energyResult = await consumeEnergy(userId, 2);
    if (!energyResult.success) {
      return res.status(400).json({ error: `Not enough energy. Need 2 ⚡ (Current: ${energyResult.currentEnergy})` });
    }

    const newBalance = (playerData.balance || 0) + job.salary
    const newClaimUtc = now.toISOString().replace('T', ' ').substring(0, 19)

    await querySqliteRun(
      'UPDATE Accounts SET Balance = ?, LastSalaryClaimUtc = ? WHERE UserId = ?',
      [newBalance, newClaimUtc, userId]
    )

    return res.json({ 
      success: true, 
      balance: newBalance, 
      amountClaimed: job.salary,
      nextClaimDate: new Date(now.getTime() + cooldownMs).toISOString(),
      lastSalaryClaimUtc: newClaimUtc,
      energy: energyResult.finalEnergy
    })
  } catch (error) {
    console.error('Failed to claim salary:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

app.post('/api/player/:id/upgrade', async (req, res) => {
  try {
    const userId = req.params.id
    const playerData = await getUserProfileFromDb(userId)
    if (!playerData) return res.status(404).json({ error: 'Player not found' })

    const jobsData = await loadDbFile('jobs.json')
    const currentJobLevel = playerData.jobLevel || 1
    const maxLevel = Math.max(...jobsData.jobs.map(j => j.level))

    if (currentJobLevel >= maxLevel) {
      return res.status(400).json({ error: 'Already at max job level' })
    }

    const nextJob = getJobByLevel(jobsData.jobs, currentJobLevel + 1)
    if (!nextJob) return res.status(400).json({ error: 'Next job not found' })

    const currentBalance = playerData.balance || 0
    if (currentBalance < nextJob.upgradeCost) {
      return res.status(400).json({ 
        error: 'Insufficient funds', 
        balance: currentBalance, 
        upgradeCost: nextJob.upgradeCost 
      })
    }

    const newBalance = currentBalance - nextJob.upgradeCost
    const newJobLevel = nextJob.level

    await querySqliteRun(
      'UPDATE Accounts SET Balance = ?, JobLevel = ? WHERE UserId = ?',
      [newBalance, newJobLevel, userId]
    )

    return res.json({ 
      success: true, 
      balance: newBalance, 
      jobLevel: newJobLevel,
      jobTitle: nextJob.title,
      jobSalary: nextJob.salary
    })
  } catch (error) {
    console.error('Failed to upgrade job:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

app.post('/api/player/:id/wheel/spin', async (req, res) => {
  try {
    const userId = req.params.id
    const playerData = await getUserProfileFromDb(userId)
    if (!playerData) return res.status(404).json({ error: 'Player not found' })

    const cooldownHours = 0.10 // matches appsettings.json
    const cooldownMs = cooldownHours * 60 * 60 * 1000
    const now = new Date()

    if (playerData.lastWheelSpinUtc) {
      const lastSpinStr = playerData.lastWheelSpinUtc.endsWith('Z') 
        ? playerData.lastWheelSpinUtc 
        : playerData.lastWheelSpinUtc + 'Z'
      const lastSpin = new Date(lastSpinStr)
      
      if (now - lastSpin < cooldownMs) {
        return res.status(400).json({ 
          error: 'Wheel on cooldown', 
          nextSpinDate: new Date(lastSpin.getTime() + cooldownMs).toISOString() 
        })
      }
    }

    const currentBalance = playerData.balance || 0
    const spinFee = Math.max(500, Math.floor(currentBalance * 0.02))

    if (currentBalance < spinFee) {
      return res.status(400).json({ 
        error: 'Insufficient balance to spin', 
        balance: currentBalance, 
        spinFee: spinFee 
      })
    }

    const energyResult = await consumeEnergy(userId, 2);
    if (!energyResult.success) {
      return res.status(400).json({ error: `Not enough energy. Need 2 ⚡ (Current: ${energyResult.currentEnergy})` });
    }

    const wheelSegments = [
      { emoji: "💎", name: "Jackpot", multiplier: 10, weight: 5 },
      { emoji: "🤑", name: "Big Win", multiplier: 5, weight: 10 },
      { emoji: "💰", name: "Nice Win", multiplier: 2, weight: 20 },
      { emoji: "💵", name: "Small Win", multiplier: 1, weight: 30 },
      { emoji: "🍀", name: "Lucky", multiplier: 0.5, weight: 25 },
      { emoji: "💔", name: "Nothing", multiplier: 0, weight: 10 }
    ];

    const totalWeight = wheelSegments.reduce((sum, seg) => sum + seg.weight, 0);
    let rand = Math.floor(Math.random() * totalWeight);
    let resultSegment = wheelSegments[wheelSegments.length - 1];

    for (const segment of wheelSegments) {
      if (rand < segment.weight) {
        resultSegment = segment;
        break;
      }
      rand -= segment.weight;
    }

    const payout = Math.floor(spinFee * resultSegment.multiplier);
    const newBalance = currentBalance - spinFee + payout;
    const newSpinUtc = now.toISOString().replace('T', ' ').substring(0, 19)

    await querySqliteRun(
      'UPDATE Accounts SET Balance = ?, LastWheelSpinUtc = ? WHERE UserId = ?',
      [newBalance, newSpinUtc, userId]
    )

    return res.json({ 
      success: true, 
      balance: newBalance,
      spinFee: spinFee,
      payout: payout,
      segmentName: resultSegment.name,
      segmentEmoji: resultSegment.emoji,
      lastWheelSpinUtc: newSpinUtc,
      nextSpinDate: new Date(now.getTime() + cooldownMs).toISOString(),
      energy: energyResult.finalEnergy
    })
  } catch (error) {
    console.error('Failed to spin wheel:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

app.get('/', (req, res) => {
  res.send('Bot mini app backend is running. Use /api/player or /api/player/:id')
})

const privKeyPath = '/etc/letsencrypt/live/ibrahim-api.duckdns.org/privkey.pem'
const fullChainPath = '/etc/letsencrypt/live/ibrahim-api.duckdns.org/fullchain.pem'

let server;
if (fsSync.existsSync(privKeyPath) && fsSync.existsSync(fullChainPath)) {
  const privateKey = fsSync.readFileSync(privKeyPath, 'utf8')
  const certificate = fsSync.readFileSync(fullChainPath, 'utf8')
  const credentials = { key: privateKey, cert: certificate }
  server = https.createServer(credentials, app)
} else {
  server = http.createServer(app)
}

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Redis setup for receiving updates from C# bot
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
    
    // Create a subscriber client for pub/sub
    const subscriber = redisClient.duplicate();
    await subscriber.connect();
    
    await subscriber.subscribe('economy_events', async (message) => {
      try {
        const data = JSON.parse(message);
        const { userId, type, ...payload } = data;
        
        if (type === 'market_update') {
          io.emit('market_update', payload.data);
          return;
        }

        if (userId && type) {
          if (type === 'force_profile_update') {
            // Fetch latest profile and push to user
            try {
              const jobsData = await loadDbFile('jobs.json')
              const treasuresData = await loadDbFile('treasures.json')
              const playerData = await getUserProfileFromDb(userId)
              if (playerData) {
                const inventory = await getInventoryForAccount(playerData.accountId)
                playerData.inventory = inventory
                
                const rankTierInfo = await getPlayerRankAndTier(userId)
                playerData.tier = rankTierInfo.tier
                playerData.tierName = getTierDisplay(rankTierInfo.tier)
                playerData.rank = rankTierInfo.rank

                const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures, playerData)
                io.to(`user_${userId}`).emit('profile_update', playerInfo);
              }
            } catch (err) {
              console.error('Failed to fetch profile on force_update:', err);
            }
          } else {
            io.to(`user_${userId}`).emit(type, payload);
          }
        }
      } catch (err) {
        console.error('Failed to parse redis message:', err);
      }
    });
    console.log('Subscribed to Redis channel: economy_events');
  } catch (err) {
    console.error('Redis connection failed:', err);
  }
})();

const connectedUsers = new Map(); // socket.id -> userId

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  socket.on('join', (userId) => {
    if (userId) {
      socket.join(`user_${userId}`);
      connectedUsers.set(socket.id, userId);
      console.log(`Socket ${socket.id} joined room user_${userId}`);
    }
  });

  socket.on('get_jobs', async (_, callback) => {
    if (!callback) return;
    try {
      const jobsData = await loadDbFile('jobs.json')
      callback({ success: true, data: jobsData.jobs })
    } catch (error) {
      console.error('Failed to load jobs via socket:', error)
      callback({ error: 'Failed to load jobs' })
    }
  });

  socket.on('request_profile', async (userId, callback) => {
    if (!callback) return;
    try {
      await updatePendingRentAsync(userId)
      const jobsData = await loadDbFile('jobs.json')
      const treasuresData = await loadDbFile('treasures.json')
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) {
        return callback({ error: 'Player not found' })
      }
      const inventory = await getInventoryForAccount(playerData.accountId)
      playerData.inventory = inventory
      
      const rankTierInfo = await getPlayerRankAndTier(userId)
      playerData.tier = rankTierInfo.tier
      playerData.tierName = getTierDisplay(rankTierInfo.tier)
      playerData.rank = rankTierInfo.rank

      const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures, playerData)
      callback({ success: true, data: playerInfo })
    } catch (error) {
      console.error('Failed to load player info via socket:', error)
      callback({ error: 'Failed to load player info' })
    }
  });

  socket.on('claim_salary', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) return callback({ error: 'Player not found' })

      const jobsData = await loadDbFile('jobs.json')
      const job = getJobByLevel(jobsData.jobs, playerData.jobLevel)
      
      const cooldownMs = 0.50 * 60 * 60 * 1000
      const now = new Date()
      if (playerData.lastSalaryClaimUtc) {
        const lastClaimStr = playerData.lastSalaryClaimUtc.endsWith('Z') 
          ? playerData.lastSalaryClaimUtc 
          : playerData.lastSalaryClaimUtc + 'Z'
        const lastClaim = new Date(lastClaimStr)
        
        if (now - lastClaim < cooldownMs) {
          return callback({ 
            error: 'Salary on cooldown', 
            nextClaimDate: new Date(lastClaim.getTime() + cooldownMs).toISOString() 
          })
        }
      }

      const energyResult = await consumeEnergy(userId, 2);
      if (!energyResult.success) {
        return callback({ error: `Not enough energy. Need 2 ⚡ (Current: ${energyResult.currentEnergy})` });
      }

      const newBalance = (playerData.balance || 0) + job.salary
      const newClaimUtc = now.toISOString().replace('T', ' ').substring(0, 19)

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, LastSalaryClaimUtc = ? WHERE UserId = ?',
        [newBalance, newClaimUtc, userId]
      )

      const payload = { 
        success: true, 
        balance: newBalance, 
        amountClaimed: job.salary,
        nextClaimDate: new Date(now.getTime() + cooldownMs).toISOString(),
        lastSalaryClaimUtc: newClaimUtc,
        energy: energyResult.finalEnergy
      };
      
      // Emit to room as well
      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, nextSalaryClaimDate: payload.nextClaimDate, energy: energyResult.finalEnergy });
      
      callback(payload);
    } catch (error) {
      console.error('Failed to claim salary:', error)
      callback({ error: 'Internal Server Error' })
    }
  });

  socket.on('upgrade_job', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) return callback({ error: 'Player not found' })

      const jobsData = await loadDbFile('jobs.json')
      const currentJobLevel = playerData.jobLevel || 1
      const maxLevel = Math.max(...jobsData.jobs.map(j => j.level))

      if (currentJobLevel >= maxLevel) {
        return callback({ error: 'Already at max job level' })
      }

      const nextJob = getJobByLevel(jobsData.jobs, currentJobLevel + 1)
      if (!nextJob) return callback({ error: 'Next job not found' })

      const currentBalance = playerData.balance || 0
      if (currentBalance < nextJob.upgradeCost) {
        return callback({ 
          error: 'Insufficient funds', 
          balance: currentBalance, 
          upgradeCost: nextJob.upgradeCost 
        })
      }

      const newBalance = currentBalance - nextJob.upgradeCost
      const newJobLevel = nextJob.level

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, JobLevel = ? WHERE UserId = ?',
        [newBalance, newJobLevel, userId]
      )

      const payload = { 
        success: true, 
        balance: newBalance, 
        jobLevel: newJobLevel,
        jobTitle: nextJob.title,
        jobSalary: nextJob.salary
      };
      
      io.to(`user_${userId}`).emit('profile_update', payload);
      
      callback(payload)
    } catch (error) {
      console.error('Failed to upgrade job:', error)
      callback({ error: 'Internal Server Error' })
    }
  });

  socket.on('spin_wheel', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) return callback({ error: 'Player not found' })

      const cooldownHours = 0.10
      const cooldownMs = cooldownHours * 60 * 60 * 1000
      const now = new Date()

      if (playerData.lastWheelSpinUtc) {
        const lastSpinStr = playerData.lastWheelSpinUtc.endsWith('Z') 
          ? playerData.lastWheelSpinUtc 
          : playerData.lastWheelSpinUtc + 'Z'
        const lastSpin = new Date(lastSpinStr)
        
        if (now - lastSpin < cooldownMs) {
          return callback({ 
            error: 'Wheel on cooldown', 
            nextSpinDate: new Date(lastSpin.getTime() + cooldownMs).toISOString() 
          })
        }
      }

      const currentBalance = playerData.balance || 0
      const spinFee = Math.max(500, Math.floor(currentBalance * 0.02))

      if (currentBalance < spinFee) {
        return callback({ 
          error: 'Insufficient balance to spin', 
          balance: currentBalance, 
          spinFee: spinFee 
        })
      }

      const energyResult = await consumeEnergy(userId, 2);
      if (!energyResult.success) {
        return callback({ error: `Not enough energy. Need 2 ⚡ (Current: ${energyResult.currentEnergy})` });
      }

      const wheelSegments = [
        { emoji: "💎", name: "Jackpot", multiplier: 10, weight: 5 },
        { emoji: "🤑", name: "Big Win", multiplier: 5, weight: 10 },
        { emoji: "💰", name: "Nice Win", multiplier: 2, weight: 20 },
        { emoji: "💵", name: "Small Win", multiplier: 1, weight: 30 },
        { emoji: "🍀", name: "Lucky", multiplier: 0.5, weight: 25 },
        { emoji: "💔", name: "Nothing", multiplier: 0, weight: 10 }
      ];

      const totalWeight = wheelSegments.reduce((sum, seg) => sum + seg.weight, 0);
      let rand = Math.floor(Math.random() * totalWeight);
      let resultSegment = wheelSegments[wheelSegments.length - 1];

      for (const segment of wheelSegments) {
        if (rand < segment.weight) {
          resultSegment = segment;
          break;
        }
        rand -= segment.weight;
      }

      const payout = Math.floor(spinFee * resultSegment.multiplier);
      const newBalance = currentBalance - spinFee + payout;
      const newSpinUtc = now.toISOString().replace('T', ' ').substring(0, 19)

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, LastWheelSpinUtc = ? WHERE UserId = ?',
        [newBalance, newSpinUtc, userId]
      )

      const payload = { 
        success: true, 
        balance: newBalance,
        spinFee: spinFee,
        payout: payout,
        segmentName: resultSegment.name,
        segmentEmoji: resultSegment.emoji,
        lastWheelSpinUtc: newSpinUtc,
        nextSpinDate: new Date(now.getTime() + cooldownMs).toISOString(),
        energy: energyResult.finalEnergy
      };
      
      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, lastWheelSpinUtc: newSpinUtc, energy: energyResult.finalEnergy });
      
      callback(payload)
    } catch (error) {
      console.error('Failed to spin wheel:', error)
      callback({ error: 'Internal Server Error' })
    }
  });



  socket.on('claim_rent', async (userId, callback) => {
    if (!callback) return;
    try {
      await updatePendingRentAsync(userId);
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const rentToClaim = playerData.unclaimedRent || 0;

      if (rentToClaim <= 0) {
        return callback({ error: 'No rent to claim' });
      }

      let newBalance = playerData.balance || 0;
      const nowUtc = new Date().toISOString().replace('T', ' ').substring(0, 19);

      // Wealth Tax Logic
      let taxDeducted = 0;
      const cooldownMs = WEALTH_TAX_COOLDOWN_HOURS * 60 * 60 * 1000;
      const lastTaxMs = playerData.lastWealthTaxUtc ? new Date(playerData.lastWealthTaxUtc.endsWith('Z') ? playerData.lastWealthTaxUtc : playerData.lastWealthTaxUtc + 'Z').getTime() : 0;
      const nowMs = Date.now();

      let newLastWealthTaxUtc = playerData.lastWealthTaxUtc;

      if (nowMs - lastTaxMs >= cooldownMs) {
        const sqlItemsValue = `
          SELECT COALESCE(SUM(CAST(ROUND(i.Price * COALESCE(mp.Multiplier, 1.0) / 1000.0) AS INTEGER) * 1000), 0) as TotalItemValue
          FROM AccountItems ai 
          JOIN Items i ON ai.ItemId = i.Id 
          LEFT JOIN MarketPrices mp ON i.Category = mp.Category 
          WHERE ai.AccountId = ?
        `;
        const itemValRow = await querySqlite(sqlItemsValue, [playerData.accountId]);
        const totalItemValue = itemValRow ? itemValRow.TotalItemValue : 0;

        if (String(userId) !== '622676944' && totalItemValue >= 10000000) {
          const rawTax = Math.floor(totalItemValue * WEALTH_TAX_PERCENTAGE);
          taxDeducted = Math.min(rawTax, newBalance);
          newBalance = Math.max(0, newBalance - taxDeducted);
          newLastWealthTaxUtc = nowUtc;
        } else {
          newLastWealthTaxUtc = nowUtc;
        }
      }

      const balanceUpdateStr = String(userId) === '622676944' 
        ? "MAX(1000000000, ?)"
        : "?";

      await querySqliteRun(
        `UPDATE Accounts SET Balance = ${balanceUpdateStr}, UnclaimedRent = 0, LastWealthTaxUtc = ? WHERE UserId = ?`,
        [newBalance, newLastWealthTaxUtc, userId]
      );

      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, unclaimedRent: 0, lastWealthTaxUtc: newLastWealthTaxUtc });
      
      const responsePayload = { success: true, balance: newBalance, claimedAmount: rentToClaim };
      if (taxDeducted > 0) {
        responsePayload.taxDeducted = taxDeducted;
      }
      callback(responsePayload);
    } catch (error) {
      console.error('Failed to claim rent:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('spin_slots', async ({userId}, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const currentBalance = playerData.balance || 0;
      const slotTempBalance = playerData.slotTempBalance || 0;
      const isFirstSpin = slotTempBalance === 0;
      const WAGER = isFirstSpin ? 10000 : 0;
      const POT_ADDITION = isFirstSpin ? 5000 : 0;
      
      if (currentBalance < WAGER) {
        return callback({ error: `Insufficient balance to start pot (Need $${WAGER.toLocaleString()})` });
      }

      const energyResult = await consumeEnergy(userId, 1);
      if (!energyResult.success) {
        return callback({ error: `Not enough energy to spin. Need 1 ⚡ (Current: ${energyResult.currentEnergy})` });
      }

      const outcomes = [
        { type: 'match_cherry', weight: 38 },
        { type: 'match_coin', weight: 34 },
        { type: 'match_skull', weight: 10 },
        { type: 'match_crown', weight: 2 },
        { type: 'match_energy', weight: 3 },
        { type: 'no_match', weight: 13 }
      ];

      const totalWeight = outcomes.reduce((acc, o) => acc + o.weight, 0);
      let rand = Math.random() * totalWeight;
      let outcome = 'no_match';
      for (const o of outcomes) {
        if (rand < o.weight) {
          outcome = o.type;
          break;
        }
        rand -= o.weight;
      }

      let slot1, slot2, slot3;
      if (outcome === 'match_cherry') {
        slot1 = slot2 = slot3 = 'cherry';
      } else if (outcome === 'match_coin') {
        slot1 = slot2 = slot3 = 'coin';
      } else if (outcome === 'match_skull') {
        slot1 = slot2 = slot3 = 'skull';
      } else if (outcome === 'match_crown') {
        slot1 = slot2 = slot3 = 'crown';
      } else if (outcome === 'match_energy') {
        slot1 = slot2 = slot3 = 'energy';
      } else {
        const symbols = ['cherry', 'coin', 'skull', 'crown', 'energy'];
        slot1 = symbols[Math.floor(Math.random() * symbols.length)];
        slot2 = symbols[Math.floor(Math.random() * symbols.length)];
        do {
          slot3 = symbols[Math.floor(Math.random() * symbols.length)];
        } while (slot1 === slot2 && slot2 === slot3);
      }

      const isMatch = (slot1 === slot2 && slot2 === slot3);
      
      let newBalance = currentBalance - WAGER;
      let newTempBalance = slotTempBalance + POT_ADDITION;
      let delta = -WAGER;
      let message = '';
      let isBust = false;
      let isCashout = false;
      let wonAmount = 0;

      if (isMatch) {
        if (slot1 === 'coin') {
          newTempBalance = newTempBalance * 3;
          message = 'Coins Match! Temp balance tripled!';
        } else if (slot1 === 'cherry') {
          newTempBalance = newTempBalance * 2;
          message = 'Berries Match! Temp balance doubled!';
        } else if (slot1 === 'skull') {
          newTempBalance = 0;
          isBust = true;
          message = 'Oh no! Devils Match! You lost your temp balance!';
        } else if (slot1 === 'crown') {
          wonAmount = newTempBalance;
          newBalance += newTempBalance;
          delta = newBalance - currentBalance;
          newTempBalance = 0;
          isCashout = true;
          message = 'Jackpot! Crowns Match! Temp balance cashed out!';
        } else if (slot1 === 'energy') {
          energyResult.finalEnergy = Math.min(20, energyResult.finalEnergy + 3);
          message = 'Zap! Energy Match! Gained 3 ⚡!';
          
          await querySqliteRun(
            'UPDATE Accounts SET Energy = ? WHERE UserId = ?',
            [energyResult.finalEnergy, userId]
          );
        }
      }

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, SlotTempBalance = ? WHERE UserId = ?',
        [newBalance, newTempBalance, userId]
      );

      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, slotTempBalance: newTempBalance, energy: energyResult.finalEnergy });
      callback({ 
        success: true, 
        balance: newBalance, 
        slotTempBalance: newTempBalance,
        energy: energyResult.finalEnergy,
        isWin: isMatch && !isBust, 
        isBust,
        isCashout,
        payout: wonAmount, 
        delta, 
        resultSlots: [slot1, slot2, slot3],
        message
      });
    } catch (error) {
      console.error('Failed to spin slots:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('flip_coin', async ({userId, wager}, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const cooldownHours = 0.05; // 3 minutes
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      const now = new Date();

      if (playerData.lastCoinFlipUtc) {
        const lastFlipStr = playerData.lastCoinFlipUtc.endsWith('Z') 
          ? playerData.lastCoinFlipUtc 
          : playerData.lastCoinFlipUtc + 'Z';
        const lastFlip = new Date(lastFlipStr);
        
        if (now - lastFlip < cooldownMs) {
          return callback({ 
            error: 'Coin flip on cooldown', 
            nextFlipDate: new Date(lastFlip.getTime() + cooldownMs).toISOString() 
          });
        }
      }

      const currentBalance = playerData.balance || 0;
      if (typeof wager !== 'number' || wager <= 0 || !Number.isInteger(wager)) {
        return callback({ error: 'Invalid wager amount' });
      }
      
      if (currentBalance < wager) {
        return callback({ error: 'Insufficient balance' });
      }

      const energyResult = await consumeEnergy(userId, 1);
      if (!energyResult.success) {
        return callback({ error: `Not enough energy. Need 1 ⚡ (Current: ${energyResult.currentEnergy})` });
      }

      // 48% win chance matching C# bot
      const isWin = Math.random() < 0.48;
      const delta = isWin ? wager : -wager;
      const newBalance = currentBalance + delta;
      const nowUtc = now.toISOString().replace('T', ' ').substring(0, 19);

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, LastCoinFlipUtc = ? WHERE UserId = ?',
        [newBalance, nowUtc, userId]
      );

      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, lastCoinFlipUtc: nowUtc, energy: energyResult.finalEnergy });
      callback({ success: true, balance: newBalance, isWin, delta, nextFlipDate: new Date(now.getTime() + cooldownMs).toISOString(), energy: energyResult.finalEnergy });
    } catch (error) {
      console.error('Failed to flip coin:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('plinko_start', async ({userId, energyUsed}, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      let finalEnergy;
      if (typeof energyUsed === 'number' && energyUsed > 0) {
        const energyResult = await consumeEnergy(userId, energyUsed);
        if (!energyResult.success) {
          return callback({ error: `Not enough energy. Need ${energyUsed} ⚡` });
        }
        finalEnergy = energyResult.finalEnergy;
      } else {
        return callback({ error: 'Invalid energy amount' });
      }

      const payload = { energy: finalEnergy };
      io.to(`user_${userId}`).emit('profile_update', payload);
      callback({ success: true, ...payload });
    } catch (error) {
      console.error('Failed to start plinko:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('plinko_settle', async ({userId, wager, winnings, energyUsed}, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const currentBalance = playerData.balance || 0;
      if (typeof wager !== 'number' || wager < 0) {
        return callback({ error: 'Invalid wager amount' });
      }
      
      if (currentBalance < wager) {
        return callback({ error: 'Insufficient balance' });
      }

      if (typeof winnings !== 'number' || winnings < 0) {
        return callback({ error: 'Invalid winnings' });
      }

      let finalEnergy;
      if (typeof energyUsed === 'number' && energyUsed > 0) {
        const energyResult = await consumeEnergy(userId, energyUsed);
        if (!energyResult.success) {
          return callback({ error: `Not enough energy. Need ${energyUsed} ⚡` });
        }
        finalEnergy = energyResult.finalEnergy;
      }

      const newBalance = Math.floor(currentBalance - wager + winnings);

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ? WHERE UserId = ?',
        [newBalance, userId]
      );

      const payload = { balance: newBalance };
      if (finalEnergy !== undefined) {
        payload.energy = finalEnergy;
      }

      io.to(`user_${userId}`).emit('profile_update', payload);
      callback({ success: true, ...payload });
    } catch (error) {
      console.error('Failed to settle plinko:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    connectedUsers.delete(socket.id);
  });
});

setInterval(async () => {
  const uniqueUsers = [...new Set(connectedUsers.values())];
  for (const userId of uniqueUsers) {
    try {
      const res = await updatePendingRentAsync(userId);
      io.to(`user_${userId}`).emit('rent_update', { unclaimedRent: res.unclaimedRent });
      io.to(`user_${userId}`).emit('profile_update', { balance: res.balance });
    } catch (err) { console.error('Rent interval error:', err); }
  }
}, 3000);

server.listen(PORT, () => {
  console.log(`Bot mini app backend socket/http server is running on port ${PORT}`)
})
