import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const PORT = process.env.PORT || 3000
const usersDbPath = path.join(__dirname, 'db', 'users.db')
const usersDb = new sqlite3.Database(usersDbPath, sqlite3.OPEN_READONLY, (err) => {
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
  const filePath = path.join(__dirname, 'db', filename)
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

function getJobByLevel(jobs, level) {
  return jobs.find(job => job.level === level) || jobs[0]
}

function buildPlayerInfo(jobs, treasures, playerData = null) {
  const defaultPlayer = {
    id: 'demo-player-1',
    name: 'Demo Player',
    username: 'guest',
    balance: 1000,
    jobLevel: 1,
    shields: 0,
    inventory: [
      { emoji: '🪙', name: 'Gold Coins', value: 2000, weight: 15 },
      { emoji: '📜', name: 'Ancient Scroll', value: 1500, weight: 15 }
    ]
  }

  const source = playerData ?? defaultPlayer
  const job = getJobByLevel(jobs, source.jobLevel)
  const treasureValue = source.inventory.reduce((sum, item) => sum + (item.value || 0), 0)
  const shields = source.shieldEndTime
    ? (new Date(source.shieldEndTime) > new Date() ? 1 : 0)
    : 0

  return {
    id: source.id,
    name: source.name,
    username: source.username,
    balance: source.balance,
    jobLevel: job.level,
    jobTitle: job.title,
    jobSalary: job.salary,
    shields,
    nextSalaryClaimDate: source.nextSalaryClaimDate || new Date(Date.now() - 1000).toISOString(),
    inventory: source.inventory,
    treasureValue,
    availableJobs: jobs,
    availableTreasures: treasures
  }
}

async function getUserProfileFromDb(userId) {
  const sql = `
    SELECT
      Accounts.AccountId,
      Accounts.UserId,
      Accounts.Balance,
      Accounts.JobLevel,
      Accounts.ShieldEndTimeUtc,
      Accounts.LastSalaryClaimUtc,
      Users.FirstName,
      Users.LastName,
      Users.Username
    FROM Accounts
    JOIN Users ON Accounts.UserId = Users.UserId
    WHERE Accounts.UserId = ?
  `
  const row = await querySqlite(sql, [userId])
  if (!row) return null

  return {
    id: String(row.UserId),
    name: [row.FirstName, row.LastName].filter(Boolean).join(' ') || row.Username || `user-${row.UserId}`,
    username: row.Username || `user-${row.UserId}`,
    balance: row.Balance,
    jobLevel: row.JobLevel,
    shieldEndTime: row.ShieldEndTimeUtc,
    nextSalaryClaimDate: row.LastSalaryClaimUtc,
    inventory: [],
  }
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
    const jobsData = await loadDbFile('jobs.json')
    const treasuresData = await loadDbFile('treasures.json')
    const playerData = await getUserProfileFromDb(req.params.id)
    const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures, playerData)
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info for id', req.params.id, error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.get('/', (req, res) => {
  res.send('Bot mini app backend is running. Use /api/player or /api/player/:id')
})

app.listen(PORT, () => {
  console.log(`Bot mini app backend is running on http://localhost:${PORT}`)
})
