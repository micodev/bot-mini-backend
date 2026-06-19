import 'dotenv/config'
import express from 'express'
import fs from 'fs/promises'
import fsSync from 'fs'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import http from 'http'
import { Server } from 'socket.io'
import { createClient } from 'redis'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const PORT = process.env.PORT || 3000
const dbDir = process.env.DB_DIR || path.join(__dirname, 'db')
const jsonDir = process.env.JSON_DIR || (process.env.DB_DIR ? path.join(dbDir, 'Data') : dbDir)

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://bot_user:bot_pass@localhost:5433/economy_db'
})

function parseDateFlexible(dateStr) {
  if (!dateStr) return new Date(NaN);
  let formatted = String(dateStr).replace(' ', 'T');
  if (!formatted.endsWith('Z')) {
    formatted += 'Z';
  }
  return new Date(formatted);
}

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err)
})

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

async function getJobsAsync() {
  const jobsDataStr = await redisClient.get('eco:jobs');
  if (jobsDataStr) {
    return JSON.parse(jobsDataStr);
  }

  const res = await pool.query('SELECT Level as level, Title as title, Salary as salary, UpgradeCost as "upgradeCost" FROM Jobs ORDER BY Level ASC');
  const jobsData = { jobs: res.rows.map(row => ({
    level: row.level,
    title: row.title,
    salary: parseInt(row.salary),
    upgradeCost: parseInt(row.upgradeCost)
  }))};

  await redisClient.set('eco:jobs', JSON.stringify(jobsData));
  return jobsData;
}

function getJobByLevel(jobs, level) {
  return jobs.find(job => job.level === level) || jobs[0]
}

function getTierDisplay(tier) {
  switch (tier) {
    case 0: return "👑 Emperor";
    case 1: return "💎 King";
    case 2: return "🥈 Prince";
    case 3: return "🥉 Duke";
    case 4: return "🎖️ Baron";
    case 5: return "🔰 Commoner";
    default: return "🔰 Commoner";
  }
}

// Redis Client
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6380'
});
redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function saveAccountToRedis(accountRaw) {
  const userId = accountRaw.UserId;
  await redisClient.set(`eco:acc:${userId}`, JSON.stringify(accountRaw));
  await redisClient.sAdd('eco:dirty_accounts', String(userId));
}

async function getItemsCatalog() {
  try {
    const cat = await redisClient.get('eco:market:items_catalog');
    if (cat) return JSON.parse(cat);
    const res = await pool.query('SELECT Id, ItemName, Price, Rarity, Category FROM Items ORDER BY Id');
    const items = res.rows.map(r => ({
      Id: parseInt(r.id), ItemName: r.itemname, Price: parseInt(r.price), Rarity: r.rarity, Category: r.category
    }));
    return items;
  } catch (err) {
    console.error('Error fetching items catalog:', err);
    return [];
  }
}

async function getUserProfileFromDb(userId) {
  try {
    const accDataStr = await redisClient.get(`eco:acc:${userId}`);
    const userDataStr = await redisClient.get(`eco:user:${userId}`);

    let account = null;
    if (accDataStr) {
      account = JSON.parse(accDataStr);
    } else {
      const res = await pool.query(`
        SELECT AccountId as "AccountId",
               UserId as "UserId",
               Balance as "Balance",
               AccountNumber as "AccountNumber",
               Thief as "Thief",
               CardTypeId as "CardTypeId",
               JobLevel as "JobLevel",
               Gender as "Gender",
               LastSalaryClaimUtc as "LastSalaryClaimUtc",
               LastTreasureHuntUtc as "LastTreasureHuntUtc",
               LastWheelSpinUtc as "LastWheelSpinUtc",
               LastInvestUtc as "LastInvestUtc",
               LastCoinFlipUtc as "LastCoinFlipUtc",
               LastStealUtc as "LastStealUtc",
               LastRaidUtc as "LastRaidUtc",
               LastBribeUtc as "LastBribeUtc",
               ShieldEndTimeUtc as "ShieldEndTimeUtc",
               LastBurgerUtc as "LastBurgerUtc",
               LastPizzaUtc as "LastPizzaUtc",
               LastCoffeeUtc as "LastCoffeeUtc",
               LastEnergyDrinkUtc as "LastEnergyDrinkUtc",
               LastRentUpdateUtc as "LastRentUpdateUtc",
               UnclaimedRent as "UnclaimedRent",
               LastWealthTaxUtc as "LastWealthTaxUtc",
               Energy as "Energy",
               LastEnergyRegenUtc as "LastEnergyRegenUtc",
               LuckBoostEndTimeUtc as "LuckBoostEndTimeUtc",
               DoubleSellCharges as "DoubleSellCharges",
               SoloRaidPasses as "SoloRaidPasses",
               LastHeistUtc as "LastHeistUtc",
               SlotTempBalance as "SlotTempBalance",
               EnergyCrashPendingPenalty as "EnergyCrashPendingPenalty",
               EnergyCrashPenalty as "EnergyCrashPenalty",
               EnergyCrashEndTimeUtc as "EnergyCrashEndTimeUtc"
        FROM Accounts WHERE UserId = $1
      `, [userId]);
      if (res.rows.length > 0) {
        account = res.rows[0];
        
        // Fetch inventory
        const invRes = await pool.query('SELECT Id as "Id", AccountId as "AccountId", ItemId as "ItemId", PurchasePrice as "PurchasePrice", PurchaseDate as "PurchaseDate" FROM AccountItems WHERE AccountId = $1', [account.AccountId]);
        account.Inventory = invRes.rows;

        // Optionally cache it
        await redisClient.set(`eco:acc:${userId}`, JSON.stringify(account));
      }
    }
    if (!account) return null;

    let user = userDataStr ? JSON.parse(userDataStr) : {};

    const salaryCooldownMs = 0.50 * 60 * 60 * 1000;
    let nextSalaryClaimDate = new Date(Date.now() - 1000).toISOString();
    if (account.LastSalaryClaimUtc) {
      const lastClaimDate = parseDateFlexible(account.LastSalaryClaimUtc);
      if (!isNaN(lastClaimDate.getTime())) {
        nextSalaryClaimDate = new Date(lastClaimDate.getTime() + salaryCooldownMs).toISOString();
      }
    }

    const playerStatsStr = await redisClient.hGet('eco:player_stats', String(userId));
    let playerStats = {};
    if (playerStatsStr) {
      playerStats = JSON.parse(playerStatsStr);
    }

    return {
      accountId: account.AccountId || 0,
      id: String(userId),
      username: user.Username || `user-${userId}`,
      name: [user.FirstName, user.LastName].filter(Boolean).join(' ') || user.Username || `user-${userId}`,
      accessHash: user.AccessHash || 0,
      accountNumber: account.AccountNumber || null,
      balance: account.Balance || 0,
      thief: account.Thief > 0,
      gender: account.Gender || null,
      cardTypeId: account.CardTypeId || 1,
      cardTypeName: account.CardTypeId === 2 ? "MasterCard" : account.CardTypeId === 3 ? "Amex" : "Visa",
      jobLevel: account.JobLevel || 1,
      rank: playerStats.Rank || -1,
      tier: playerStats.Tier || 5,
      tierName: playerStats.TierName || "🔰 Commoner",
      shieldEndTimeUtc: account.ShieldEndTimeUtc || null,
      nextSalaryClaimDate,
      lastSalaryClaimUtc: account.LastSalaryClaimUtc || null,
      lastTreasureHuntUtc: account.LastTreasureHuntUtc || null,
      lastWheelSpinUtc: account.LastWheelSpinUtc || null,
      lastInvestUtc: account.LastInvestUtc || null,
      lastCoinFlipUtc: account.LastCoinFlipUtc || null,
      lastStealUtc: account.LastStealUtc || null,
      lastRaidUtc: account.LastRaidUtc || null,
      lastBribeUtc: account.LastBribeUtc || null,
      lastBurgerUtc: account.LastBurgerUtc || null,
      lastHeistUtc: account.LastHeistUtc || null,
      lastRentUpdateUtc: account.LastRentUpdateUtc || null,
      unclaimedRent: account.UnclaimedRent || 0,
      lastWealthTaxUtc: account.LastWealthTaxUtc || null,
      slotTempBalance: account.SlotTempBalance || 0,
      energy: account.Energy ?? 20,
      lastEnergyRegenUtc: account.LastEnergyRegenUtc || null,
      energyCrashPendingPenalty: account.EnergyCrashPendingPenalty || 0,
      energyCrashPenalty: account.EnergyCrashPenalty || 0,
      energyCrashEndTimeUtc: account.EnergyCrashEndTimeUtc || null,
      luckBoostEndTimeUtc: account.LuckBoostEndTimeUtc || null,
      doubleSellCharges: account.DoubleSellCharges || 0,
      soloRaidPasses: account.SoloRaidPasses || 0,
      maxInventoryCapacity: account.MaxInventoryCapacity || 60,
      createdAt: user.CreatedAt || null,
      lastSeen: user.LastSeen || null,
      inventory: account.Inventory || [],
      _rawAccount: account
    };
  } catch (err) {
    console.error('getUserProfileFromDb error:', err);
    return null;
  }
}

async function getPlayerRankAndTier(userId) {
  if (String(userId) === '622676944') {
    return { tier: 0, rank: 1 };
  }
  try {
    const sql = `
      SELECT 
        (SELECT COUNT(*) FROM Accounts WHERE UserId != 622676944) AS total,
        (SELECT COUNT(*) FROM Accounts WHERE UserId != 622676944 AND Balance < COALESCE((SELECT Balance FROM Accounts WHERE UserId = $1), 0)) AS strictless,
        (SELECT COUNT(*) FROM Accounts WHERE UserId != 622676944 AND Balance = COALESCE((SELECT Balance FROM Accounts WHERE UserId = $1), 0)) AS equal,
        (SELECT COUNT(*) FROM Accounts WHERE UserId != 622676944 AND Balance > COALESCE((SELECT Balance FROM Accounts WHERE UserId = $1), 0)) AS strictgreater
    `;
    const res = await pool.query(sql, [userId]);
    if (!res.rows || res.rows.length === 0 || parseInt(res.rows[0].total) === 0) return { tier: 5, rank: 1 };

    const row = res.rows[0];
    const total = parseInt(row.total) || 1;
    const strictLess = parseInt(row.strictless) || 0;
    const equal = parseInt(row.equal) || 0;
    const strictGreater = parseInt(row.strictgreater) || 0;

    const percentile = (strictLess + 0.5 * equal) / total;

    let tier = 5;
    const tierRes = await pool.query('SELECT Level, MinPercentile FROM Tiers ORDER BY Level DESC');
    for (const t of tierRes.rows) {
      if (percentile >= t.minpercentile) {
        tier = t.level;
      }
    }
    return { tier, rank: strictGreater + 1 };
  } catch (err) {
    console.error("Failed to get rank and tier:", err);
    return { tier: 5, rank: -1 };
  }
}

async function consumeEnergy(userId, amount) {
  const profile = await getUserProfileFromDb(userId);
  if (!profile) return { success: false, error: 'Player not found' };
  const raw = profile._rawAccount;

  let penalty = raw.EnergyCrashPenalty || 0;
  if (raw.EnergyCrashEndTimeUtc) {
    const penaltyEnd = parseDateFlexible(raw.EnergyCrashEndTimeUtc);
    if (!isNaN(penaltyEnd.getTime()) && penaltyEnd <= new Date()) {
      penalty = 0;
      raw.EnergyCrashPendingPenalty = 0;
      raw.EnergyCrashPenalty = 0;
      raw.EnergyCrashEndTimeUtc = null;
    }
  }

  let currentEnergy = raw.Energy ?? MAX_ENERGY;
  let lastRegenUtc = raw.LastEnergyRegenUtc;
  const maxEnergy = MAX_ENERGY - penalty;

  let newRegenTime = lastRegenUtc ? parseDateFlexible(lastRegenUtc) : new Date();

  if (currentEnergy < maxEnergy && lastRegenUtc && !isNaN(newRegenTime.getTime())) {
    const now = Date.now();
    const lastTime = newRegenTime.getTime();
    const diffMs = now - lastTime;
    if (diffMs > 0) {
      const elapsedHours = diffMs / (1000 * 60 * 60);
      const energyToAdd = Math.floor(elapsedHours * ENERGY_REGEN_PER_HOUR);
      if (energyToAdd > 0) {
        currentEnergy = Math.min(maxEnergy, currentEnergy + energyToAdd);
        const minutesPerEnergy = 60.0 / ENERGY_REGEN_PER_HOUR;
        newRegenTime = new Date(lastTime + (energyToAdd * minutesPerEnergy * 60 * 1000));
      }
    }
  } else if (currentEnergy >= maxEnergy) {
    newRegenTime = new Date();
  }

  if (currentEnergy < amount) {
    return { success: false, error: 'Not enough energy', currentEnergy };
  }

  raw.Energy = currentEnergy - amount;
  const newRegenTimeStr = newRegenTime.toISOString().replace('T', ' ').substring(0, 19);
  raw.LastEnergyRegenUtc = newRegenTimeStr;

  await saveAccountToRedis(raw);

  return { success: true, finalEnergy: raw.Energy, newRegenTimeStr };
}

async function getInventoryForAccount(playerData) {
  const catalog = await getItemsCatalog();
  const catalogMap = new Map(catalog.map(i => [i.Id, i]));

  return (playerData.inventory || []).map(ai => {
    const item = catalogMap.get(ai.ItemId) || {};
    return {
      accountItemId: ai.Id,
      itemId: ai.ItemId,
      name: item.ItemName || 'Unknown Item',
      price: item.Price || 0,
      purchasePrice: ai.PurchasePrice || 0,
      purchaseDate: ai.PurchaseDate,
      rarity: item.Rarity,
      category: item.Category,
      value: item.Price || 0
    };
  });
}

const MARKET_CATEGORIES = ["Real Estate", "Vehicles", "Private Jets", "Jewelry", "Adult Toys", "Nightlife", "Sexy Clothing"];
const RENT_YIELD_PER_MINUTE = parseFloat(process.env.RENT_YIELD_PER_MINUTE || 1.0);
const SALARY_COOLDOWN_HOURS = parseFloat(process.env.SALARY_COOLDOWN_HOURS || 0.001);
const WHEEL_COOLDOWN_HOURS = parseFloat(process.env.WHEEL_COOLDOWN_HOURS || 0.001);
const COIN_FLIP_COOLDOWN_HOURS = parseFloat(process.env.COIN_FLIP_COOLDOWN_HOURS || 0);
const MAX_ENERGY = parseInt(process.env.MAX_ENERGY || 20);
const ENERGY_REGEN_PER_HOUR = parseFloat(process.env.ENERGY_REGEN_PER_HOUR || 2.0);

async function updatePendingRentAsync(userId) {
  const profile = await getUserProfileFromDb(userId);
  if (!profile) return { unclaimedRent: 0, balance: 0 };
  const raw = profile._rawAccount;

  let lastRentUpdateDate = parseDateFlexible(raw.LastRentUpdateUtc);
  let lastRentUpdateMs = !isNaN(lastRentUpdateDate.getTime()) ? lastRentUpdateDate.getTime() : 0;

  const inventory = await getInventoryForAccount(profile);
  const marketPricesStr = await redisClient.get('eco:market:prices');
  const marketPrices = marketPricesStr ? JSON.parse(marketPricesStr) : {};

  let totalRentGenerated = 0;
  const now = Date.now();

  for (const item of inventory) {
    if (!item.category || !MARKET_CATEGORIES.includes(item.category)) continue;

    const catState = marketPrices[item.category];
    let multiplier = catState && catState.Multiplier !== null ? catState.Multiplier : 1.0;
    let currentMarketPrice = Math.round((item.price * multiplier) / 1000.0) * 1000;

    let pDate = parseDateFlexible(item.purchaseDate);
    let purchaseDateMs = !isNaN(pDate.getTime()) ? pDate.getTime() : 0;

    let startTimeMs = lastRentUpdateMs > purchaseDateMs ? lastRentUpdateMs : purchaseDateMs;

    let timeActiveMinutes = (now - startTimeMs) / (1000 * 60);

    if (timeActiveMinutes > 0) {
      totalRentGenerated += timeActiveMinutes * currentMarketPrice * RENT_YIELD_PER_MINUTE;
    }
  }

  let claimableRent = Math.floor(totalRentGenerated);
  if (claimableRent > 0) {
    const maxVaultLimit = 1000000;
    let remainingRent = claimableRent;

    if ((raw.Balance || 0) < maxVaultLimit) {
      const allowedToBalance = maxVaultLimit - (raw.Balance || 0);
      const toAdd = Math.min(remainingRent, allowedToBalance);
      if (String(userId) === '622676944') {
        raw.Balance = Math.max(1000000000, (raw.Balance || 0) + toAdd);
      } else {
        raw.Balance = (raw.Balance || 0) + toAdd;
      }
      remainingRent -= toAdd;
    }

    if (remainingRent > 0) {
      const allowedToVault = maxVaultLimit - (raw.UnclaimedRent || 0);
      if (allowedToVault > 0) {
        const toAdd = Math.min(remainingRent, allowedToVault);
        raw.UnclaimedRent = (raw.UnclaimedRent || 0) + toAdd;
      }
    }

    raw.LastRentUpdateUtc = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await saveAccountToRedis(raw);
  }

  return { unclaimedRent: raw.UnclaimedRent || 0, balance: raw.Balance || 0 };
}

function buildPlayerInfo(jobs, playerData = null) {
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
    gender: source.gender,
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
    lastHeistUtc: source.lastHeistUtc,
    lastRentUpdateUtc: source.lastRentUpdateUtc,
    unclaimedRent: source.unclaimedRent,
    lastWealthTaxUtc: source.lastWealthTaxUtc,
    slotTempBalance: source.slotTempBalance ?? 0,
    energy: source.energy ?? 20,
    lastEnergyRegenUtc: source.lastEnergyRegenUtc,
    energyCrashPendingPenalty: source.energyCrashPendingPenalty,
    energyCrashPenalty: source.energyCrashPenalty,
    energyCrashEndTimeUtc: source.energyCrashEndTimeUtc,
    luckBoostEndTimeUtc: source.luckBoostEndTimeUtc,
    doubleSellCharges: source.doubleSellCharges,
    soloRaidPasses: source.soloRaidPasses,
    maxInventoryCapacity: source.maxInventoryCapacity,
    createdAt: source.createdAt,
    lastSeen: source.lastSeen,
    inventory,
    treasureValue,
  }
}

app.get('/api/player', async (req, res) => {
  try {
    const jobsData = await getJobsAsync()
    const playerInfo = buildPlayerInfo(jobsData.jobs)
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info:', error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.get('/api/player/:id', async (req, res) => {
  try {
    await updatePendingRentAsync(req.params.id)
    const jobsData = await getJobsAsync()
    const playerData = await getUserProfileFromDb(req.params.id)
    if (!playerData) {
      return res.status(404).json({ error: 'Player not found' })
    }
    const inventory = await getInventoryForAccount(playerData)
    playerData.inventory = inventory

    const rankTierInfo = await getPlayerRankAndTier(req.params.id)
    playerData.tier = rankTierInfo.tier
    playerData.tierName = getTierDisplay(rankTierInfo.tier)
    playerData.rank = rankTierInfo.rank

    const playerInfo = buildPlayerInfo(jobsData.jobs, playerData)
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info for id', req.params.id, error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.get('/api/jobs', async (req, res) => {
  try {
    const jobsData = await getJobsAsync()
    return res.json(jobsData.jobs)
  } catch (error) {
    console.error('Failed to load jobs:', error)
    return res.status(500).json({ error: 'Failed to load jobs' })
  }
})

app.get('/api/market', async (req, res) => {
  try {
    const marketPricesStr = await redisClient.get('eco:market:prices')
    const marketPrices = marketPricesStr ? JSON.parse(marketPricesStr) : {}
    const marketData = {}
    for (const [category, state] of Object.entries(marketPrices)) {
      marketData[category] = {
        multiplier: state.Multiplier,
        trend: state.Trend,
        lastUpdated: state.LastUpdated
      }
    }
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

    const jobsData = await getJobsAsync()
    const job = getJobByLevel(jobsData.jobs, playerData.jobLevel)

    const cooldownMs = 0.50 * 60 * 60 * 1000
    const now = new Date()
    if (playerData.lastSalaryClaimUtc) {
      const lastClaim = parseDateFlexible(playerData.lastSalaryClaimUtc)

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

    const raw = playerData._rawAccount;
    raw.Balance = newBalance;
    raw.LastSalaryClaimUtc = newClaimUtc;
    await saveAccountToRedis(raw);

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

    const jobsData = await getJobsAsync()
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

    const raw = playerData._rawAccount;
    raw.Balance = newBalance;
    raw.JobLevel = newJobLevel;
    await saveAccountToRedis(raw);

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

    const cooldownHours = 0.10
    const cooldownMs = cooldownHours * 60 * 60 * 1000
    const now = new Date()

    if (playerData.lastWheelSpinUtc) {
      const lastSpin = parseDateFlexible(playerData.lastWheelSpinUtc)

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

    const raw = playerData._rawAccount;
    raw.Balance = newBalance;
    raw.LastWheelSpinUtc = newSpinUtc;
    await saveAccountToRedis(raw);

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

(async () => {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');

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
            try {
              const jobsData = await getJobsAsync()
              const playerData = await getUserProfileFromDb(userId)
              if (playerData) {
                const inventory = await getInventoryForAccount(playerData)
                playerData.inventory = inventory

                const rankTierInfo = await getPlayerRankAndTier(userId)
                playerData.tier = rankTierInfo.tier
                playerData.tierName = getTierDisplay(rankTierInfo.tier)
                playerData.rank = rankTierInfo.rank

                const playerInfo = buildPlayerInfo(jobsData.jobs, playerData)
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
      const jobsData = await getJobsAsync()
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
      const jobsData = await getJobsAsync()
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) {
        return callback({ error: 'Player not found' })
      }
      const inventory = await getInventoryForAccount(playerData)
      playerData.inventory = inventory

      const rankTierInfo = await getPlayerRankAndTier(userId)
      playerData.tier = rankTierInfo.tier
      playerData.tierName = getTierDisplay(rankTierInfo.tier)
      playerData.rank = rankTierInfo.rank

      const playerInfo = buildPlayerInfo(jobsData.jobs, playerData)
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

      const jobsData = await getJobsAsync()
      const job = getJobByLevel(jobsData.jobs, playerData.jobLevel)

      const cooldownMs = 0.50 * 60 * 60 * 1000
      const now = new Date()
      if (playerData.lastSalaryClaimUtc) {
        const lastClaim = parseDateFlexible(playerData.lastSalaryClaimUtc)

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

      const raw = playerData._rawAccount;
      raw.Balance = newBalance;
      raw.LastSalaryClaimUtc = newClaimUtc;
      await saveAccountToRedis(raw);

      const payload = {
        success: true,
        balance: newBalance,
        amountClaimed: job.salary,
        nextClaimDate: new Date(now.getTime() + cooldownMs).toISOString(),
        lastSalaryClaimUtc: newClaimUtc,
        energy: energyResult.finalEnergy
      };

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

      const jobsData = await getJobsAsync()
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

      const raw = playerData._rawAccount;
      raw.Balance = newBalance;
      raw.JobLevel = newJobLevel;
      await saveAccountToRedis(raw);

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
        const lastSpin = parseDateFlexible(playerData.lastWheelSpinUtc)

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

      const raw = playerData._rawAccount;
      raw.Balance = newBalance;
      raw.LastWheelSpinUtc = newSpinUtc;
      await saveAccountToRedis(raw);

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

      let taxDeducted = 0;
      const inventory = await getInventoryForAccount(playerData);
      let totalItemValue = 0;

      for (const item of inventory) {
        totalItemValue += item.price || 0;
      }

      if (String(userId) !== '622676944' && totalItemValue > 10000000) {
        taxDeducted = Math.floor(rentToClaim * 0.02);
      }

      newBalance = newBalance + (rentToClaim - taxDeducted);

      const raw = playerData._rawAccount;
      if (String(userId) === '622676944') {
        raw.Balance = Math.max(1000000000, newBalance);
      } else {
        raw.Balance = newBalance;
      }
      raw.UnclaimedRent = 0;
      await saveAccountToRedis(raw);

      io.to(`user_${userId}`).emit('profile_update', { balance: raw.Balance, unclaimedRent: 0 });

      const responsePayload = { success: true, balance: raw.Balance, claimedAmount: rentToClaim };
      if (taxDeducted > 0) {
        responsePayload.taxDeducted = taxDeducted;
      }
      callback(responsePayload);
    } catch (error) {
      console.error('Failed to claim rent:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('spin_slots', async ({ userId }, callback) => {
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

      const raw = playerData._rawAccount;

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
          raw.Energy = Math.min(20, (raw.Energy || 0) + 3);
          energyResult.finalEnergy = raw.Energy;
          message = 'Zap! Energy Match! Gained 3 ⚡!';
        }
      }

      raw.Balance = newBalance;
      raw.SlotTempBalance = newTempBalance;
      await saveAccountToRedis(raw);

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

  socket.on('flip_coin', async ({ userId, wager }, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });

      const cooldownHours = 0.05; // 3 minutes
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      const now = new Date();

      if (playerData.lastCoinFlipUtc) {
        const lastFlip = parseDateFlexible(playerData.lastCoinFlipUtc);

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

      const isWin = Math.random() < 0.48;
      const delta = isWin ? wager : -wager;
      const newBalance = currentBalance + delta;
      const nowUtc = now.toISOString().replace('T', ' ').substring(0, 19);

      const raw = playerData._rawAccount;
      raw.Balance = newBalance;
      raw.LastCoinFlipUtc = nowUtc;
      await saveAccountToRedis(raw);

      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, lastCoinFlipUtc: nowUtc, energy: energyResult.finalEnergy });
      callback({ success: true, balance: newBalance, isWin, delta, nextFlipDate: new Date(now.getTime() + cooldownMs).toISOString(), energy: energyResult.finalEnergy });
    } catch (error) {
      console.error('Failed to flip coin:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('plinko_start', async ({ userId, energyUsed }, callback) => {
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

  socket.on('plinko_settle', async ({ userId, wager, winnings, energyUsed }, callback) => {
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

      const raw = playerData._rawAccount;
      raw.Balance = newBalance;
      await saveAccountToRedis(raw);

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
