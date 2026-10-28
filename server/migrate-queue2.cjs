// Database migration for queue2 sending support
// Adds delivery mode, account selection, status tracking, and timestamps

const {DatabaseSync} = require('node:sqlite');

function migrateQueue2(db) {
  // Check if migration already applied
  const hasDeliveryMode = db.prepare(
    "SELECT 1 FROM pragma_table_info('queue2') WHERE name='delivery_mode'"
  ).get();
  
  if (hasDeliveryMode) {
    console.log('queue2 send columns already exist, skipping migration');
    return;
  }
  
  console.log('Migrating queue2 table for send support...');
  
  db.exec('BEGIN');
  
  try {
    // Add delivery and account selection columns
    db.exec(`
      ALTER TABLE queue2 ADD COLUMN delivery_mode TEXT CHECK(delivery_mode IN ('pool', 'beta'));
      ALTER TABLE queue2 ADD COLUMN user_account_id TEXT;
      ALTER TABLE queue2 ADD COLUMN poster_account INTEGER;
    `);
    
    // Add status tracking columns
    db.exec(`
      ALTER TABLE queue2 ADD COLUMN send_status TEXT DEFAULT 'ready' 
        CHECK(send_status IN ('ready', 'sending', 'submitted', 'published', 'failed', 'cancelled'));
      ALTER TABLE queue2 ADD COLUMN engain_task_id TEXT;
      ALTER TABLE queue2 ADD COLUMN reddit_url TEXT;
      ALTER TABLE queue2 ADD COLUMN send_error TEXT;
      ALTER TABLE queue2 ADD COLUMN send_reason TEXT;
    `);
    
    // Add timestamps
    db.exec(`
      ALTER TABLE queue2 ADD COLUMN reserved_at TEXT;
      ALTER TABLE queue2 ADD COLUMN sent_at TEXT;
      ALTER TABLE queue2 ADD COLUMN published_at TEXT;
      ALTER TABLE queue2 ADD COLUMN failed_at TEXT;
      ALTER TABLE queue2 ADD COLUMN last_status_check TEXT;
    `);
    
    // Add override flags
    db.exec(`
      ALTER TABLE queue2 ADD COLUMN thread_check_override BOOLEAN DEFAULT 0;
    `);
    
    db.exec('COMMIT');
    console.log('✓ queue2 migration complete');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Pacing state table for rate limiting
function createPacingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue2_pacing (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      last_send_global TEXT,
      sends_today_utc INTEGER DEFAULT 0,
      today_utc_date TEXT,
      subreddit_last_send TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    
    INSERT OR IGNORE INTO queue2_pacing (id, updated_at) 
    VALUES (1, datetime('now'));
  `);
}

module.exports = {migrateQueue2, createPacingTable};
