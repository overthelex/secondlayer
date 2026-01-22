#!/usr/bin/env node

const fs = require('fs');
const https = require('https');

const TODAY = '2026-01-19';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function analyzeTodayUpdates() {
  console.log('\n🔍 АНАЛІЗ ОНОВЛЕНЬ ЗА 19.01.2026\n');

  // Аналіз законопроектів IX скликання
  console.log('📜 Завантаження законопроектів IX скликання...');

  try {
    const zprUrl = 'https://data.rada.gov.ua/ogd/zpr/skl9/bills-main.json';
    const bills = await fetchJson(zprUrl);

    console.log(`\n✅ Завантажено ${bills.length} законопроектів`);

    // Знайти останні зареєстровані
    const recentBills = bills
      .filter(b => b.rejestrDate && b.rejestrDate.startsWith('2026-01'))
      .sort((a, b) => b.rejestrDate.localeCompare(a.rejestrDate))
      .slice(0, 10);

    console.log(`\n📊 Останні ${recentBills.length} законопроектів січня 2026:\n`);
    recentBills.forEach((b, i) => {
      console.log(`${i + 1}. ${b.number} - ${b.name}`);
      console.log(`   Дата реєстрації: ${b.rejestrDate}`);
      console.log(`   Ініціатор: ${b.personId || b.nomberAutor || 'N/A'}`);
      console.log(`   Головний комітет: ${b.mainKomitet || 'N/A'}`);
      console.log(`   Стадія: ${b.lastEvent || 'N/A'}`);
      console.log();
    });

    // Статистика по типах
    const byType = {};
    bills.forEach(b => {
      const type = b.typeId || 'інше';
      byType[type] = (byType[type] || 0) + 1;
    });

    console.log('📈 Статистика за типами документів:');
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([type, count]) => {
        console.log(`   ${type}: ${count}`);
      });

  } catch (err) {
    console.log(`❌ Помилка: ${err.message}`);
  }
}

analyzeTodayUpdates().catch(console.error);
