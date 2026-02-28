import { initDatabase, deleteSession } from './src/db.js';

async function main() {
  try {
    initDatabase();
    
    // Delete all sessions
    deleteSession('main');
    
    console.log('All agent sessions cleared successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error clearing sessions:', error);
    process.exit(1);
  }
}

main();