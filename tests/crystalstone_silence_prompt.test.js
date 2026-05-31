const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scenarioPath = path.join(__dirname, '..', 'crystalstone_server_edition.js');
const source = fs.readFileSync(scenarioPath, 'utf8');

assert.match(source, /CLIENT_SILENCE_PROMPT_MS\s*=\s*18000/);
assert.match(source, /CLIENT_SILENCE_HANGUP_MS\s*=\s*40000/);
assert.match(source, /CLIENT_SILENCE_MAX_PROMPTS\s*=\s*1/);
assert.match(source, /scheduleClientSilenceReprompt/);
assert.match(source, /scheduleClientSilenceHangup/);
assert.match(source, /client_silence_reprompt/);
assert.match(source, /client_silence_hangup/);
assert.match(source, /Повторите громче, пожалуйста/);
assert.match(source, /Извините, вас не было слышно\. Завершу звонок/);
assert.match(source, /не угадывай имя/i);
assert.match(source, /не говори «Поняла вас» как универсальную реакцию/i);

console.log('crystalstone_silence_prompt.test.js passed');
