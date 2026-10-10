const fs = require('fs');
const vm = require('vm');
const DIR = require('path').join(__dirname, '..') + '/';

const pad = n => (n < 10 ? '0' : '') + n;
const sandbox = {
  console,
  Logger: { log: () => {} },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      if (fmt === 'dd.MM.yyyy HH:mm:ss')
        return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      if (fmt === 'yyyy-MM-dd_HH-mm')
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
      return String(d);
    },
    getUuid: () => 'x'.repeat(36),
  },
  SpreadsheetApp: {}, CacheService: {}, PropertiesService: {}, MailApp: {},
  DriveApp: {}, Session: {}, ContentService: {},
};
vm.createContext(sandbox);
for (const f of ['Util.gs', 'Auth.gs', 'Code.gs', 'Catalog.gs', 'History.gs']) {
  vm.runInContext(fs.readFileSync(DIR + f, 'utf8'), sandbox, { filename: f });
}
module.exports = sandbox;
