/**
 * Laws (not codes) published as public SEO pages under /zakon/<slug>: the
 * 100 laws lawyers look up most, picked by how often court decisions cite
 * them (law_court_citations) and checked to have a current edition with
 * parsed articles in npa.*. They share the flat /zakon/<slug> namespace with
 * the codes. Slugs are fixed by hand like the codes': they are permanent
 * URLs and must never change once published.
 */
import type { ZakonCode } from './zakon-codes.js';

/** title: the act's own title ("Про нотаріат"); abbr: short label for breadcrumbs. */
function law(slug: string, nreg: string, title: string, abbr: string): ZakonCode {
  // "Основи законодавства України про …" is a law too, but is not called "Закон"
  const osnovy = title.startsWith('Основи ');
  return {
    slug,
    nreg,
    name: osnovy ? title : `Закон України «${title}»`,
    articleRef: osnovy ? title.replace(/^Основи /, 'Основ ') : `Закону України «${title}»`,
    abbr,
    articleTitles: true,
    kind: 'law',
  };
}

export const ZAKON_LAWS: ZakonCode[] = [
  law('osnovy-zakonodavstva-pro-okhoronu-zdorovia', '2801-12', 'Основи законодавства України про охорону здоров’я', 'Основи законодавства про охорону здоров’я'),
  law('pro-avtorske-pravo-i-sumizhni-prava', '2811-20', 'Про авторське право і суміжні права', 'Закон про авторське право'),
  law('pro-advokaturu-ta-advokatsku-diialnist', '5076-17', 'Про адвокатуру та адвокатську діяльність', 'Закон про адвокатуру'),
  law('pro-administratyvnyi-nahliad-za-osobamy-zvilnenymy-z-mists-pozbavlennia-voli', '264/94-вр', 'Про адміністративний нагляд за особами, звільненими з місць позбавлення волі', 'Закон про адміністративний нагляд'),
  law('pro-administratyvni-posluhy', '5203-17', 'Про адміністративні послуги', 'Закон про адміністративні послуги'),
  law('pro-administratyvnu-protseduru', '2073-20', 'Про адміністративну процедуру', 'Закон про адміністративну процедуру'),
  law('pro-aktsionerni-tovarystva', '2465-20', 'Про акціонерні товариства', 'Закон про акціонерні товариства'),
  law('pro-alternatyvnu-neviiskovu-sluzhbu', '1975-12', 'Про альтернативну (невійськову) службу', 'Закон про альтернативну службу'),
  law('pro-banky-i-bankivsku-diialnist', '2121-14', 'Про банки і банківську діяльність', 'Закон про банки і банківську діяльність'),
  law('pro-bezoplatnu-pravnychu-dopomohu', '3460-17', 'Про безоплатну правничу допомогу', 'Закон про безоплатну правничу допомогу'),
  law('pro-bizhentsiv-ta-osib-yaki-potrebuiut-dodatkovoho-abo-tymchasovoho-zakhystu', '3671-17', 'Про біженців та осіб, які потребують додаткового або тимчасового захисту', 'Закон про біженців'),
  law('pro-valiutu-i-valiutni-operatsii', '2473-19', 'Про валюту і валютні операції', 'Закон про валюту і валютні операції'),
  law('pro-vykonavche-provadzhennia', '1404-19', 'Про виконавче провадження', 'Закон про виконавче провадження'),
  law('pro-vykonannia-rishen-ta-zastosuvannia-praktyky-yespl', '3477-15', 'Про виконання рішень та застосування практики Європейського суду з прав людини', 'Закон про виконання рішень ЄСПЛ'),
  law('pro-vyshchu-radu-pravosuddia', '1798-19', 'Про Вищу раду правосуддя', 'Закон про Вищу раду правосуддя'),
  law('pro-vidpustky', '504/96-вр', 'Про відпустки', 'Закон про відпустки'),
  law('pro-viiskovyi-oboviazok-i-viiskovu-sluzhbu', '2232-12', 'Про військовий обов’язок і військову службу', 'Закон про військовий обов’язок'),
  law('pro-hromadianstvo-ukrainy', '2235-14', 'Про громадянство України', 'Закон про громадянство України'),
  law('pro-derzhavne-biuro-rozsliduvan', '794-19', 'Про Державне бюро розслідувань', 'Закон про Державне бюро розслідувань'),
  law('pro-derzhavnyi-zemelnyi-kadastr', '3613-17', 'Про Державний земельний кадастр', 'Закон про Державний земельний кадастр'),
  law('pro-derzhavnyi-kordon-ukrainy', '1777-12', 'Про державний кордон України', 'Закон про державний кордон України'),
  law('pro-derzhavnu-dopomohu-simiam-z-ditmy', '2811-12', 'Про державну допомогу сім’ям з дітьми', 'Закон про допомогу сім’ям з дітьми'),
  law('pro-derzhavnu-reiestratsiiu-aktiv-tsyvilnoho-stanu', '2398-17', 'Про державну реєстрацію актів цивільного стану', 'Закон про РАЦС'),
  law('pro-derzhavnu-reiestratsiiu-rechovykh-prav-na-nerukhome-maino-ta-yikh-obtiazhen', '1952-15', 'Про державну реєстрацію речових прав на нерухоме майно та їх обтяжень', 'Закон про держреєстрацію речових прав'),
  law('pro-derzhavnu-reiestratsiiu-yurydychnykh-osib-fop-ta-hromadskykh-formuvan', '755-15', 'Про державну реєстрацію юридичних осіб, фізичних осіб - підприємців та громадських формувань', 'Закон про держреєстрацію юросіб і ФОП'),
  law('pro-derzhavnu-sluzhbu', '889-19', 'Про державну службу', 'Закон про державну службу'),
  law('pro-dorozhnii-rukh', '3353-12', 'Про дорожній рух', 'Закон про дорожній рух'),
  law('pro-dostup-do-publichnoi-informatsii', '2939-17', 'Про доступ до публічної інформації', 'Закон про доступ до публічної інформації'),
  law('pro-dostup-do-sudovykh-rishen', '3262-15', 'Про доступ до судових рішень', 'Закон про доступ до судових рішень'),
  law('pro-elektronni-dokumenty-ta-elektronnyi-dokumentoobih', '851-15', 'Про електронні документи та електронний документообіг', 'Закон про електронні документи'),
  law('pro-elektronnu-komertsiiu', '675-19', 'Про електронну комерцію', 'Закон про електронну комерцію'),
  law('pro-zhytlovo-komunalni-posluhy', '2189-19', 'Про житлово-комунальні послуги', 'Закон про ЖКП'),
  law('pro-zabezpechennia-prav-i-svobod-vnutrishno-peremishchenykh-osib', '1706-18', 'Про забезпечення прав і свобод внутрішньо переміщених осіб', 'Закон про ВПО'),
  law('pro-pravovyi-rezhym-na-tymchasovo-okupovanii-terytorii', '1207-18', 'Про забезпечення прав і свобод громадян та правовий режим на тимчасово окупованій території України', 'Закон про тимчасово окуповану територію'),
  law('pro-zahalnooboviazkove-derzhavne-pensiine-strakhuvannia', '1058-15', 'Про загальнообов’язкове державне пенсійне страхування', 'Закон про пенсійне страхування'),
  law('pro-zahalnooboviazkove-derzhavne-sotsialne-strakhuvannia', '1105-14', 'Про загальнообов’язкове державне соціальне страхування', 'Закон про соціальне страхування'),
  law('pro-zainiatist-naselennia', '5067-17', 'Про зайнятість населення', 'Закон про зайнятість населення'),
  law('pro-zapobihannia-koruptsii', '1700-18', 'Про запобігання корупції', 'Закон про запобігання корупції'),
  law('pro-zapobihannia-ta-protydiiu-domashnomu-nasylstvu', '2229-19', 'Про запобігання та протидію домашньому насильству', 'Закон про домашнє насильство'),
  law('pro-zapobihannia-ta-protydiiu-lehalizatsii-vidmyvanniu-dokhodiv', '361-20', 'Про запобігання та протидію легалізації (відмиванню) доходів, одержаних злочинним шляхом, фінансуванню тероризму та фінансуванню розповсюдження зброї масового знищення', 'Закон про фінансовий моніторинг'),
  law('pro-zastosuvannia-reiestratoriv-rozrakhunkovykh-operatsii', '265/95-вр', 'Про застосування реєстраторів розрахункових операцій у сфері торгівлі, громадського харчування та послуг', 'Закон про РРО'),
  law('pro-zakhyst-ekonomichnoi-konkurentsii', '2210-14', 'Про захист економічної конкуренції', 'Закон про захист економічної конкуренції'),
  law('pro-zakhyst-personalnykh-danykh', '2297-17', 'Про захист персональних даних', 'Закон про захист персональних даних'),
  law('pro-zakhyst-prav-spozhyvachiv', '1023-12', 'Про захист прав споживачів', 'Закон про захист прав споживачів'),
  law('pro-zbir-ta-oblik-yedynoho-vnesku', '2464-17', 'Про збір та облік єдиного внеску на загальнообов’язкове державне соціальне страхування', 'Закон про ЄСВ'),
  law('pro-zvernennia-hromadian', '393/96-вр', 'Про звернення громадян', 'Закон про звернення громадян'),
  law('pro-zemleustrii', '858-15', 'Про землеустрій', 'Закон про землеустрій'),
  law('pro-ipoteku', '898-15', 'Про іпотеку', 'Закон про іпотеку'),
  law('pro-konstytutsiinyi-sud-ukrainy', '2136-19', 'Про Конституційний Суд України', 'Закон про Конституційний Суд України'),
  law('pro-mediatsiiu', '1875-20', 'Про медіацію', 'Закон про медіацію'),
  law('pro-mizhnarodne-pryvatne-pravo', '2709-15', 'Про міжнародне приватне право', 'Закон про міжнародне приватне право'),
  law('pro-mizhnarodnyi-komertsiinyi-arbitrazh', '4002-12', 'Про міжнародний комерційний арбітраж', 'Закон про міжнародний комерційний арбітраж'),
  law('pro-mistseve-samovriaduvannia-v-ukraini', '280/97-вр', 'Про місцеве самоврядування в Україні', 'Закон про місцеве самоврядування в Україні'),
  law('pro-mobilizatsiinu-pidhotovku-ta-mobilizatsiiu', '3543-12', 'Про мобілізаційну підготовку та мобілізацію', 'Закон про мобілізацію'),
  law('pro-natsionalne-antykoruptsiine-biuro-ukrainy', '1698-18', 'Про Національне антикорупційне бюро України', 'Закон про Національне антикорупційне бюро України'),
  law('pro-natsionalnu-politsiiu', '580-19', 'Про Національну поліцію', 'Закон про Національну поліцію'),
  law('pro-notariat', '3425-12', 'Про нотаріат', 'Закон про нотаріат'),
  law('pro-obiednannia-spivvlasnykiv-bahatokvartyrnoho-budynku', '2866-14', 'Про об’єднання співвласників багатоквартирного будинку', 'Закон про ОСББ'),
  law('pro-oboviazkove-strakhuvannia-tsyvilno-pravovoi-vidpovidalnosti-vlasnykiv-tz', '3720-20', 'Про обов’язкове страхування цивільно-правової відповідальності власників наземних транспортних засобів', 'Закон про ОСЦПВ'),
  law('pro-oboronu-ukrainy', '1932-12', 'Про оборону України', 'Закон про оборону України'),
  law('pro-operatyvno-rozshukovu-diialnist', '2135-12', 'Про оперативно-розшукову діяльність', 'Закон про оперативно-розшукову діяльність'),
  law('pro-oplatu-pratsi', '108/95-вр', 'Про оплату праці', 'Закон про оплату праці'),
  law('pro-orhany-ta-osib-yaki-zdiisniuiut-prymusove-vykonannia', '1403-19', 'Про органи та осіб, які здійснюють примусове виконання судових рішень і рішень інших органів', 'Закон про органи примусового виконання'),
  law('pro-orendu-derzhavnoho-ta-komunalnoho-maina', '157-20', 'Про оренду державного та комунального майна', 'Закон про оренду державного майна'),
  law('pro-orendu-zemli', '161-14', 'Про оренду землі', 'Закон про оренду землі'),
  law('pro-osnovy-sotsialnoi-zakhyshchenosti-osib-z-invalidnistiu-v-ukraini', '875-12', 'Про основи соціальної захищеності осіб з інвалідністю в Україні', 'Закон про соцзахист осіб з інвалідністю'),
  law('pro-osoblyvosti-zdiisnennia-prava-vlasnosti-u-bahatokvartyrnomu-budynku', '417-19', 'Про особливості здійснення права власності у багатоквартирному будинку', 'Закон про право власності у багатоквартирному будинку'),
  law('pro-okhoronu-dytynstva', '2402-14', 'Про охорону дитинства', 'Закон про охорону дитинства'),
  law('pro-okhoronu-prav-na-znaky-dlia-tovariv-i-posluh', '3689-12', 'Про охорону прав на знаки для товарів і послуг', 'Закон про торговельні марки'),
  law('pro-okhoronu-pratsi', '2694-12', 'Про охорону праці', 'Закон про охорону праці'),
  law('pro-pensiine-zabezpechennia', '1788-12', 'Про пенсійне забезпечення', 'Закон про пенсійне забезпечення'),
  law('pro-pensiine-zabezpechennia-osib-zvilnenykh-z-viiskovoi-sluzhby', '2262-12', 'Про пенсійне забезпечення осіб, звільнених з військової служби, та деяких інших осіб', 'Закон про пенсії військовослужбовців'),
  law('pro-platizhni-posluhy', '1591-20', 'Про платіжні послуги', 'Закон про платіжні послуги'),
  law('pro-poperednie-uviaznennia', '3352-12', 'Про попереднє ув’язнення', 'Закон про попереднє ув’язнення'),
  law('pro-pravovyi-rezhym-voiennoho-stanu', '389-19', 'Про правовий режим воєнного стану', 'Закон про правовий режим воєнного стану'),
  law('pro-pravovyi-status-inozemtsiv-ta-osib-bez-hromadianstva', '3773-17', 'Про правовий статус іноземців та осіб без громадянства', 'Закон про правовий статус іноземців'),
  law('pro-pryvatyzatsiiu-derzhavnoho-i-komunalnoho-maina', '2269-19', 'Про приватизацію державного і комунального майна', 'Закон про приватизацію'),
  law('pro-prozhytkovyi-minimum', '966-14', 'Про прожитковий мінімум', 'Закон про прожитковий мінімум'),
  law('pro-prokuraturu', '1697-18', 'Про прокуратуру', 'Закон про прокуратуру'),
  law('pro-psykhiatrychnu-dopomohu', '1489-14', 'Про психіатричну допомогу', 'Закон про психіатричну допомогу'),
  law('pro-publichni-zakupivli', '922-19', 'Про публічні закупівлі', 'Закон про публічні закупівлі'),
  law('pro-rehuliuvannia-mistobudivnoi-diialnosti', '3038-17', 'Про регулювання містобудівної діяльності', 'Закон про містобудівну діяльність'),
  law('pro-sanktsii', '1644-18', 'Про санкції', 'Закон про санкції'),
  law('pro-svobodu-peresuvannia-ta-vilnyi-vybir-mistsia-prozhyvannia-v-ukraini', '1382-15', 'Про свободу пересування та вільний вибір місця проживання в Україні', 'Закон про свободу пересування'),
  law('pro-systemu-harantuvannia-vkladiv-fizychnykh-osib', '4452-17', 'Про систему гарантування вкладів фізичних осіб', 'Закон про гарантування вкладів'),
  law('pro-sluzhbu-bezpeky-ukrainy', '2229-12', 'Про Службу безпеки України', 'Закон про Службу безпеки України'),
  law('pro-sotsialnyi-zakhyst-ditei-viiny', '2195-15', 'Про соціальний захист дітей війни', 'Закон про дітей війни'),
  law('pro-sotsialnyi-i-pravovyi-zakhyst-viiskovosluzhbovtsiv-ta-chleniv-yikh-simei', '2011-12', 'Про соціальний і правовий захист військовослужбовців та членів їх сімей', 'Закон про соцзахист військовослужбовців'),
  law('pro-spozhyvche-kredytuvannia', '1734-19', 'Про споживче кредитування', 'Закон про споживче кредитування'),
  law('pro-status-veteraniv-viiny-harantii-yikh-sotsialnoho-zakhystu', '3551-12', 'Про статус ветеранів війни, гарантії їх соціального захисту', 'Закон про статус ветеранів війни'),
  law('pro-status-postrazhdalykh-vnaslidok-chornobylskoi-katastrofy', '796-12', 'Про статус і соціальний захист громадян, які постраждали внаслідок Чорнобильської катастрофи', 'Закон про чорнобильців'),
  law('pro-strakhuvannia', '1909-20', 'Про страхування', 'Закон про страхування'),
  law('pro-sudovyi-zbir', '3674-17', 'Про судовий збір', 'Закон про судовий збір'),
  law('pro-sudovu-ekspertyzu', '4038-12', 'Про судову експертизу', 'Закон про судову експертизу'),
  law('pro-sudoustrii-i-status-suddiv', '1402-19', 'Про судоустрій і статус суддів', 'Закон про судоустрій'),
  law('pro-teplopostachannia', '2633-15', 'Про теплопостачання', 'Закон про теплопостачання'),
  law('pro-tovarystva-z-obmezhenoiu-ta-dodatkovoiu-vidpovidalnistiu', '2275-19', 'Про товариства з обмеженою та додатковою відповідальністю', 'Закон про ТОВ і ТДВ'),
  law('pro-treteiski-sudy', '1701-15', 'Про третейські суди', 'Закон про третейські суди'),
  law('pro-fermerske-hospodarstvo', '973-15', 'Про фермерське господарство', 'Закон про фермерське господарство'),
  law('pro-finansovi-posluhy-ta-finansovi-kompanii', '1953-20', 'Про фінансові послуги та фінансові компанії', 'Закон про фінансові послуги'),
];

function artKey(artNo: string): [number, number] {
  const [a, b] = artNo.split('-');
  return [Number(a), b === undefined ? 0 : Number(b)];
}

/** Largest jump in article numbers still taken as the law's own (repealed articles leave gaps). */
const MAX_GAP = 4;

/**
 * npa.article also holds the articles that a law's final provisions insert
 * into or restate for other acts ("Стаття 188-13" of КУпАП inside «Про
 * виконавче провадження», "Стаття 385" of ЦК inside the condominium law).
 * They come after the law's own articles, which run in increasing order, so
 * the index is cut at the first article that goes backwards or jumps ahead
 * by more than MAX_GAP. Only applied to laws: codes have long legitimate
 * gaps (ЦК 141 → 152).
 */
export function ownArticles<T extends { artNo: string }>(index: T[]): T[] {
  let prev: [number, number] = [0, 0];
  for (let i = 0; i < index.length; i++) {
    const k = artKey(index[i].artNo);
    const backwards = k[0] < prev[0] || (k[0] === prev[0] && k[1] <= prev[1]);
    if (backwards || k[0] > prev[0] + MAX_GAP) return index.slice(0, i);
    prev = k;
  }
  return index;
}
