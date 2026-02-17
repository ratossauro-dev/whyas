const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bot.db');

let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        initTables();
    }
    return db;
}

function initTables() {
    const d = getDb();
    d.exec(`
        CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT,
            name TEXT,
            ip TEXT,
            connected_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);
    d.exec(`
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            message TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);
}

function saveConnection(phone, name, ip) {
    const d = getDb();
    d.prepare('INSERT INTO connections (phone, name, ip) VALUES (?, ?, ?)').run(phone, name, ip);
}

function getConnections(limit = 50) {
    const d = getDb();
    return d.prepare('SELECT * FROM connections ORDER BY id DESC LIMIT ?').all(limit);
}

function getConnectionCount() {
    const d = getDb();
    return d.prepare('SELECT COUNT(*) as total FROM connections').get().total;
}

function addLog(type, message) {
    const d = getDb();
    d.prepare('INSERT INTO logs (type, message) VALUES (?, ?)').run(type, message);
}

function getLogs(limit = 50) {
    const d = getDb();
    return d.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
}

function getStats() {
    const d = getDb();
    const totalConnections = d.prepare('SELECT COUNT(*) as c FROM connections').get().c;
    const totalLogs = d.prepare('SELECT COUNT(*) as c FROM logs').get().c;
    const todayConnections = d.prepare(
        "SELECT COUNT(*) as c FROM connections WHERE date(connected_at) = date('now', 'localtime')"
    ).get().c;
    return { totalConnections, todayConnections, totalLogs };
}

function getConnectionsByDay(days = 7) {
    const d = getDb();
    return d.prepare(`
        SELECT date(connected_at) as date, COUNT(*) as count
        FROM connections
        WHERE connected_at >= datetime('now', '-${days} days', 'localtime')
        GROUP BY date(connected_at)
        ORDER BY date(connected_at) DESC
    `).all();
}

module.exports = { saveConnection, getConnections, getConnectionCount, addLog, getLogs, getStats, getConnectionsByDay };
