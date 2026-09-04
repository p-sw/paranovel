import '../load-env';
import { DatabaseService } from './database.service';

const database = new DatabaseService();
database.onApplicationShutdown();
process.stdout.write('SQLite migrations applied.\n');
