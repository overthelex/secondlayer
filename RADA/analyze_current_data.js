#!/usr/bin/env node

const fs = require('fs');

console.log('\n📊 АНАЛІЗ ПОТОЧНИХ ДАНИХ ВЕРХОВНОЇ РАДИ (станом на 19.01.2026)\n');
console.log('='.repeat(80));

// 1. Аналіз депутатів IX скликання
console.log('\n👥 ДЕПУТАТИ IX СКЛИКАННЯ\n');

const mpsData = JSON.parse(fs.readFileSync('mps_skl9.json', 'utf-8'));

console.log(`Загальна структура даних:`);
console.log(`  - Типи помічників: ${mpsData.assistant_types?.length || 0}`);
console.log(`  - Фракції та об'єднання: ${mpsData.fr_associations?.length || 0}`);
console.log(`  - Депутати: ${mpsData.mps?.length || 0}`);
console.log(`  - Помічники депутатів: ${mpsData.mps_assistants?.length || 0}`);

if (mpsData.mps && mpsData.mps.length > 0) {
  console.log(`\n📈 Статистика по депутатам:`);

  // По статусу
  const byStatus = {};
  mpsData.mps.forEach(mp => {
    const status = mp.active_mps ? 'Активний' : 'Неактивний';
    byStatus[status] = (byStatus[status] || 0) + 1;
  });

  console.log(`\n  Статус:`);
  Object.entries(byStatus).forEach(([status, count]) => {
    console.log(`    ${status}: ${count}`);
  });

  // По фракціям (останні)
  const byFraction = {};
  mpsData.mps.forEach(mp => {
    if (mp.current_fr_name) {
      byFraction[mp.current_fr_name] = (byFraction[mp.current_fr_name] || 0) + 1;
    }
  });

  console.log(`\n  По фракціям/групам (ТОП-10):`);
  Object.entries(byFraction)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([fr, count]) => {
      console.log(`    ${fr}: ${count}`);
    });

  // По комітетам
  const byCommittee = {};
  mpsData.mps.forEach(mp => {
    if (mp.main_komitet_name) {
      byCommittee[mp.main_komitet_name] = (byCommittee[mp.main_komitet_name] || 0) + 1;
    }
  });

  console.log(`\n  По головним комітетам (ТОП-5):`);
  Object.entries(byCommittee)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([com, count]) => {
      console.log(`    ${com}: ${count}`);
    });

  // Гендерна статистика
  const byGender = {};
  mpsData.mps.forEach(mp => {
    const gender = mp.sex === 'Ж' ? 'Жінки' : 'Чоловіки';
    byGender[gender] = (byGender[gender] || 0) + 1;
  });

  console.log(`\n  Гендерний склад:`);
  Object.entries(byGender).forEach(([gender, count]) => {
    const percent = ((count / mpsData.mps.length) * 100).toFixed(1);
    console.log(`    ${gender}: ${count} (${percent}%)`);
  });
}

// 2. Помічники
if (mpsData.mps_assistants && mpsData.mps_assistants.length > 0) {
  console.log(`\n📋 Помічники депутатів:`);
  console.log(`  Всього: ${mpsData.mps_assistants.length}`);

  const byType = {};
  mpsData.mps_assistants.forEach(a => {
    const type = a.type_name || 'Не вказано';
    byType[type] = (byType[type] || 0) + 1;
  });

  console.log(`\n  За типами:`);
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`    ${type}: ${count}`);
  });
}

// 3. Інформація про оновлення
console.log('\n');
console.log('='.repeat(80));

const metaFiles = {
  'Депутати': 'mps_meta.json',
  'Законопроекти': 'zpr_meta.json',
  'Пленарні засідання': 'zal_meta.json',
  'Засідання': 'meetings_meta.json'
};

console.log('\n🔄 ОСТАННІ ОНОВЛЕННЯ ДАНИХ:\n');

Object.entries(metaFiles).forEach(([name, file]) => {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`${name}:`);
    console.log(`  Оновлено: ${data.lastBuildDate || data.pubDate || 'N/A'}`);
    console.log(`  Набір містить: ${data.item?.length || 0} піднаборів`);
    console.log();
  } catch (e) {
    console.log(`${name}: помилка читання\n`);
  }
});

console.log('='.repeat(80));
console.log('\n✅ Аналіз завершено\n');
