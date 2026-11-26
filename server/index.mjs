// Marvii bot: Telegram, the G2 glasses API, and the alerts loop, in one process.
import { startHttp } from './http.mjs';
import { startBot } from './bot.mjs';
import { startPolling } from './core.mjs';
import { loadStt } from './stt.mjs';

startHttp();
startBot();
startPolling();
// Load the speech model in the background so the first voice command isn't slow.
loadStt().then(() => console.log('speech model ready'), (e) => console.error(`speech model: ${e.message}`));
