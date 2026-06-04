import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

async function loadDbFile(filename) {
  const filePath = path.join(__dirname, 'db', filename)
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

function getJobByLevel(jobs, level) {
  return jobs.find(job => job.level === level) || jobs[0]
}

function buildPlayerInfo(jobs, treasures) {
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

  const job = getJobByLevel(jobs, defaultPlayer.jobLevel)
  const treasureValue = defaultPlayer.inventory.reduce((sum, item) => sum + (item.value || 0), 0)

  return {
    id: defaultPlayer.id,
    name: defaultPlayer.name,
    username: defaultPlayer.username,
    balance: defaultPlayer.balance,
    jobLevel: job.level,
    jobTitle: job.title,
    jobSalary: job.salary,
    shields: defaultPlayer.shields,
    nextSalaryClaimDate: new Date(Date.now() - 1000).toISOString(),
    inventory: defaultPlayer.inventory,
    treasureValue,
    availableJobs: jobs,
    availableTreasures: treasures
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
    const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures)
    playerInfo.id = req.params.id
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info for id', req.params.id, error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.listen(PORT, () => {
  console.log(`Bot mini app backend is running on http://localhost:${PORT}`)
})
