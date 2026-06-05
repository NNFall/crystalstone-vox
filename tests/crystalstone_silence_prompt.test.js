const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scenarioPath = path.join(__dirname, '..', 'crystalstone_server_edition.js');
const source = fs.readFileSync(scenarioPath, 'utf8');

assert.match(source, /CLIENT_SILENCE_PROMPT_MS\s*=\s*5000/);
assert.match(source, /CLIENT_SILENCE_HANGUP_MS\s*=\s*40000/);
assert.match(source, /CLIENT_SILENCE_MAX_PROMPTS\s*=\s*1/);
assert.match(source, /scheduleClientSilenceReprompt/);
assert.match(source, /scheduleClientSilenceHangup/);
assert.match(source, /client_silence_reprompt/);
assert.match(source, /client_silence_hangup/);
assert.match(source, /Повторите громче, пожалуйста/);
assert.match(source, /Извините, вас не было слышно\. Завершу звонок/);
assert.match(source, /Клиент не отвечает или его плохо слышно уже около 5 секунд/);
assert.match(source, /if \(outputText\) \{\s*clearClientSilenceWaitTimers\(\);/);
assert.match(source, /не угадывай имя/i);
assert.match(source, /не говори «Поняла»/i);
assert.match(source, /«Угу»/);
assert.match(source, /«Ага»/);
assert.match(source, /не спрашивай повторно, какое изделие нужно/i);
assert.match(source, /если клиент уже сказал, что нужна столешница/i);
assert.match(source, /если спрашиваешь «Остались ли у вас еще вопросы\?»/i);
assert.match(source, /обязательно остановись на этом вопросе/i);
assert.match(source, /прощание разрешено только после отдельного ответа клиента/i);
assert.match(source, /после ответа клиента, что вопросов больше нет, скажи только одну финальную фразу/i);
assert.match(source, /не повторяй «Всего доброго» второй раз/i);
assert.match(source, /не добавляй второе прощание/i);

console.log('crystalstone_silence_prompt.test.js passed');
