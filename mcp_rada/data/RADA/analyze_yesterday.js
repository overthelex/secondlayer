#!/usr/bin/env node

const fs = require('fs');

// Вчорашня дата: 18.01.2026
const YESTERDAY = '2026-01-18';

function analyzeDataset(filename, datasetName) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 Аналіз: ${datasetName}`);
  console.log('='.repeat(80));

  const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));

  console.log(`\n📅 Загальні дати оновлення:`);
  console.log(`   pubDate: ${data.pubDate || 'N/A'}`);
  console.log(`   lastBuildDate: ${data.lastBuildDate || 'N/A'}`);

  const yesterdayItems = [];

  if (data.item && Array.isArray(data.item)) {
    data.item.forEach(item => {
      const pubDate = item.pubDate || '';
      const lastBuildDate = item.lastBuildDate || '';

      if (pubDate.startsWith(YESTERDAY) || lastBuildDate.startsWith(YESTERDAY)) {
        yesterdayItems.push({
          id: item.id,
          title: item.title,
          pubDate: pubDate,
          lastBuildDate: lastBuildDate,
          type: item.type,
          description: item.description
        });
      }
    });
  }

  if (yesterdayItems.length > 0) {
    console.log(`\n✅ Знайдено ${yesterdayItems.length} оновлень від ${YESTERDAY}:\n`);
    yesterdayItems.forEach((item, i) => {
      console.log(`${i + 1}. ${item.title}`);
      console.log(`   ID: ${item.id}`);
      console.log(`   Тип: ${item.type || 'N/A'}`);
      if (item.description) {
        console.log(`   Опис: ${item.description}`);
      }
      console.log(`   pubDate: ${item.pubDate || 'N/A'}`);
      if (item.lastBuildDate) {
        console.log(`   lastBuildDate: ${item.lastBuildDate}`);
      }
      console.log();
    });
  } else {
    console.log(`\n❌ Оновлень від ${YESTERDAY} не знайдено`);
  }

  // Показати всі унікальні дати для розуміння
  const allDates = new Set();
  if (data.item && Array.isArray(data.item)) {
    data.item.forEach(item => {
      if (item.pubDate) {
        const date = item.pubDate.split('T')[0];
        allDates.add(date);
      }
      if (item.lastBuildDate) {
        const date = item.lastBuildDate.split('T')[0];
        allDates.add(date);
      }
    });
  }

  console.log(`\n📆 Останні дати оновлень у наборі:`);
  const sortedDates = Array.from(allDates).sort().reverse().slice(0, 5);
  sortedDates.forEach(date => console.log(`   - ${date}`));

  return yesterdayItems;
}

console.log('\n🔍 АНАЛІЗ ДАНИХ ВЕРХОВНОЇ РАДИ ЗА 18.01.2026\n');

const datasets = [
  ['mps_meta.json', 'Народні депутати'],
  ['zpr_meta.json', 'Законопроекти'],
  ['zal_meta.json', 'Пленарні засідання'],
  ['meetings_meta.json', 'Засідання']
];

let totalYesterdayUpdates = 0;

datasets.forEach(([file, name]) => {
  try {
    const updates = analyzeDataset(file, name);
    totalYesterdayUpdates += updates.length;
  } catch (err) {
    console.log(`\n❌ Помилка при обробці ${file}: ${err.message}`);
  }
});

console.log('\n' + '='.repeat(80));
console.log(`📈 ПІДСУМОК: Знайдено ${totalYesterdayUpdates} оновлень від ${YESTERDAY}`);
console.log('='.repeat(80) + '\n');
