#!/bin/bash
# This script will guide you through using the Playwright MCP browser to scrape NAIS pages

echo "NAIS Open Data Scraper - MCP Browser Method"
echo "============================================"
echo ""
echo "This will use Claude's Playwright browser to scrape all 11 registry pages."
echo "Please run the following commands in sequence."
echo ""
echo "Commands to copy and paste:"
echo ""

urls=(
  "https://nais.gov.ua/m/ediniy-derjavniy-reestr-yuridichnih-osib-fizichnih-osib-pidpriemtsiv-ta-gromadskih-formuvan"
  "https://nais.gov.ua/m/ediniy-reestr-notariusiv-188"
  "https://nais.gov.ua/m/derjavniy-reestr-atestovanih-sudovih-ekspertiv-189"
  "https://nais.gov.ua/m/ediniy-reestr-spetsialnih-blankiv-notarialnih-dokumentiv-190"
  "https://nais.gov.ua/m/reestr-metodik-provedennya-sudovih-ekspertiz-192"
  "https://nais.gov.ua/m/ediniy-reestr-pidpriemstv-schodo-yakih-porusheno-vprovadjennya-u-spravi-pro-bankrutstvo"
  "https://nais.gov.ua/m/ediniy-reestr-arbitrajnih-keruyuchih-ukraini"
  "https://nais.gov.ua/m/ediniy-derjavniy-reestr-normativno-pravovih-aktiv-196"
  "https://nais.gov.ua/m/slovnik-administrativno-teritorialnogo-ustroyu-ukraini-slovnik-vulits-naselenih-punktiv-ta-vulits-imenovanih-obektiv"
  "https://nais.gov.ua/m/informatsiya-z-avtomatizovanoi-sistemi-vikonavchogo-provadjennya-595"
  "https://nais.gov.ua/m/ediniy-reestr-borjnikiv-549"
)

for i in "${!urls[@]}"; do
  num=$((i + 1))
  echo "# Registry $num:"
  echo "Navigate to: ${urls[$i]}"
  echo "Then run evaluation to extract links"
  echo ""
done
