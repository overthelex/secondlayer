Судові рішення 

Документація: https://court.searcher.api.zakononline.com.ua/apidoc/index.html 

Розділ документації, який описує пошук: 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetSearchText 

Отримання мета-інформації за пошуковим запитом: 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetEntitiesMeta With 

Довідники: 

● Суди https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Court ● Інстанції https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Instance ● Типи 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-JudgmentForm ● Судочинство 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-JusticeKind ● Регіони https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Region ● Судді https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Judge 

**Приклади** 

Пошук по інстанції і повному тексту судового рішення, використовуючи бінарні оператори, з урахування дат додавання: 

curl \--location \--globoff 

'https://court.searcher.api.zakononline.com.ua/v1/search?where\[date\_publ\]\[o p\]=%24between\&where\[date\_publ\]\[value\]\[0\]=2023-01-01%2000%3A00%3A00\&where\[da te\_publ\]\[value\]\[1\]=2023-02-01%2000%3A00%3A00\&target=text\&mode=sph04\&where\[i nstance\_code\]\[op\]=%24in\&where\[instance\_code\]\[value\]\[0\]=1\&limit=40\&order\[dat e\_publ\]=desc\&search=%22%D0%86%D1%81%D1%82%D0%BE%D1%80%D0%B8%D1%87%D0%BD%D0% B8%D0%B9%20%D0%B0%D1%80%D0%B5%D0%B0%D0%BB%22' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json' 

Отримання по цьому запиту мета-інформацію: 

curl \--location \--globoff 

'https://court.searcher.api.zakononline.com.ua/v1/search/meta?where\[date\_pu  
bl\]\[op\]=%24between\&where\[date\_publ\]\[value\]\[0\]=2023-01-01%2000%3A00%3A00\&whe re\[date\_publ\]\[value\]\[1\]=2023-02-01%2000%3A00%3A00\&target=text\&mode=sph04\&wh ere\[instance\_code\]\[op\]=%24in\&where\[instance\_code\]\[value\]\[0\]=1\&limit=40\&orde r\[date\_publ\]=desc\&search=%22%D0%86%D1%81%D1%82%D0%BE%D1%80%D0%B8%D1%87%D0%B D%D0%B8%D0%B9%20%D0%B0%D1%80%D0%B5%D0%B0%D0%BB%22' \\ 

\--header 'Accept: application/json' \\ 

\--header 'X-App-Token: {APIKey}' 

Отримати довідник: 

curl \--location 

'https://court.searcher.api.zakononline.com.ua/v1/instances?limit=5\&page=1' \\ 

\--header 'X-App-Token: {APIKey}' 

\--header 'Accept: application/json' 

Судові засідання 

Документація: https://court.searcher.api.zakononline.com.ua/apidoc/index.html 

Розділ документації, який описує пошук: 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-CourtSession-GetSearchT ext 

Отримання мета-інформації по пошуковому запиту: 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-CourtSession-GetEntitiesM etaWith 

Довідники: 

● Суди 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-CourtSessionCourt ● Інстанції 

https://court.searcher.api.zakononline.com.ua/apidoc/index.html\#api-JusticeKind 

**Приклади** 

Пошук по судочинству і повному тексту судового рішення, з урахування дат засідання: 

curl \--location \--globoff 

'https://court.searcher.api.zakononline.com.ua/v1/court\_sessions/search?ful  
ldata=1\&results=lite\&page=1\&limit=50\&order%5Bweight%5D=desc\&mode=sph04\&sear ch=%22%D0%B4%D0%B5%D0%B2%D0%B5%D0%BB%D0%BE%D0%BF%20%D1%84%D1%96%D0%BD%D0%B0 %D0%BD%D1%81%22\&target=case\_involved\&where%5Bjustice\_kind%5D%5Bop%5D=%24in& where%5Bjustice\_kind%5D%5Bvalue%5D%5B0%5D=2\&where\[date\_session\]\[op\]=%3E%3D& where\[date\_session\]\[value\]=2023-08-02%2000%3A00%3A00\&select=id' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json' 

Отримання по цьому запиту мета-інформацію: 

curl \--location \--globoff 

'https://court.searcher.api.zakononline.com.ua/v1/court\_sessions/search/met a?fulldata=1\&results=lite\&page=1\&limit=50\&order%5Bweight%5D=desc\&mode=sph04 \&search=%22%D0%B4%D0%B5%D0%B2%D0%B5%D0%BB%D0%BE%D0%BF%20%D1%84%D1%96%D0%BD% D0%B0%D0%BD%D1%81%22\&target=case\_involved\&where%5Bjustice\_kind%5D%5Bop%5D=% 24in\&where%5Bjustice\_kind%5D%5Bvalue%5D%5B0%5D=2\&where\[date\_session\]\[op\]=%3 E%3D\&where\[date\_session\]\[value\]=2023-08-02%2000%3A00%3A00\&select=id' \\ 

\--header 'Accept: application/json' \\ 

\--header 'X-App-Token: {APIKey}' 

Отримати судів засідань: 

curl \--location 

'https://court.searcher.api.zakononline.com.ua/v1/court\_session\_court?limit \=5\&page=1' \\ 

\--header 'X-App-Token: {APIKey}' 

\--header 'Accept: application/json' 

Отримати документ з повним текстом за номером (doc\_id): 

curl \--location 

'https://court.searcher.api.zakononline.com.ua/v1/document/by/number/962437 73' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json' 

Нормативно-правові акти 

Документація: https://searcher.api.zakononline.com.ua/apidoc/index.html 

Розділ документації, який описує пошук: 

https://searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetSearchText  
Отримання мета-інформації по пошуковому запиту: 

https://searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetEntitiesMetaWith 

Довідники: 

● Типи https://searcher.api.zakononline.com.ua/apidoc/index.html\#api-DocumentTypes ● Видавники https://searcher.api.zakononline.com.ua/apidoc/index.html\#api-Authors 

**Приклади** 

Пошук за датою і повним текстом: 

curl \--location \--globoff 

'https://searcher.api.zakononline.com.ua/v1/search?mode=sph04\&target=title& limit=5\&search=%D0%A6%D0%98%D0%92%D0%86%D0%9B%D0%AC%D0%9D%D0%98%D0%99%20%D0 %9F%D0%A0%D0%9E%D0%A6%D0%95%D0%A1%D0%A3%D0%90%D0%9B%D0%AC%D0%9D%D0%98%D0%99 %20%D0%9A%D0%9E%D0%94%D0%95%D0%9A%D0%A1%20%D0%A3%D0%9A%D0%A0%D0%90%D0%87%D0 %9D%D0%98\&results=lite\&where\[version\_date\]\[op\]=%3C%3D\&where\[version\_date\]\[v alue\]=2018-07-01' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json' 

Отримання по цьому запиту мета-інформацію: 

curl \--location \--globoff 

'https://searcher.api.zakononline.com.ua/v1/search/meta?mode=sph04\&target=t itle\&limit=5\&search=%D0%A6%D0%98%D0%92%D0%86%D0%9B%D0%AC%D0%9D%D0%98%D0%99% 20%D0%9F%D0%A0%D0%9E%D0%A6%D0%95%D0%A1%D0%A3%D0%90%D0%9B%D0%AC%D0%9D%D0%98% D0%99%20%D0%9A%D0%9E%D0%94%D0%95%D0%9A%D0%A1%20%D0%A3%D0%9A%D0%A0%D0%90%D0% 87%D0%9D%D0%98\&results=lite\&where\[version\_date\]\[op\]=%3C%3D\&where\[version\_da te\]\[value\]=2018-07-01' \\ 

\--header 'Accept: application/json' \\ 

\--header 'X-App-Token: {APIKey}' 

Отримати довідник: 

curl \--location 

'https://searcher.ldb.webt.com.ua/v1/authors?limit=5\&page=1' \\ \--header 'X-App-Token: {APIKey}' 

\--header 'Accept: application/json'  
Судова практика 

Документація: https://courtpractice.searcher.api.zakononline.com.ua/apidoc/index.html 

Розділ документації, який описує пошук: 

https://courtpractice.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetSearc hText 

Отримання мета-інформації по пошуковому запиту: 

https://courtpractice.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetEntiti esMetaWith 

Довідники: 

● Категорії 

https://courtpractice.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Category ● Типи https://courtpractice.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Type 

**Приклади** 

Пошук за типом і повним текстом: 

curl \--location \--globoff 

'https://courtpractice.searcher.api.zakononline.com.ua/v1/search?target=tex t\&search=911%2F1693%2F18\&where\[type\_id\]\[op\]=%24in\&where\[type\_id\]\[value\]\[0\]= 1' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json' 

Отримання по цьому запиту мета-інформацію: 

curl \--location \--globoff 

'https://courtpractice.searcher.api.zakononline.com.ua/v1/search/meta?targe t=text\&search=911%2F1693%2F18\&where\[type\_id\]\[op\]=%24in\&where\[type\_id\]\[value \]\[0\]=1' \\ 

\--header 'Accept: application/json' \\ 

\--header 'X-App-Token: {APIKey}' 

Отримати довідник: 

curl \--location 

'https://courtpractice.searcher.api.zakononline.com.ua/v1/types?nolimits=1' \\ 

\--header 'X-App-Token: {APIKey}' \\  
\--header 'Accept: application/json' 

Практика ЄСПЛ 

Документація: https://echrpractice.searcher.api.zakononline.com.ua/apidoc/index.html 

Розділ документації, який описує пошук: 

https://echrpractice.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetSearc hText 

Отримання мета-інформації по пошуковому запиту: 

https://echrpractice.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Searcher-GetEntitie sMetaWith 

Довідники: 

● Типи 

https://echrpractice.searcher.api.zakononline.com.ua/apidoc/index.html\#api-Type-GetEnt ities 

**Приклади** 

Пошук за типом і повним текстом: 

curl \--location \-g \--request GET 

'https://echrpractice.searcher.api.zakononline.com.ua/v1/search?mode=sph04& target=text\&limit=5\&search=%D0%B7%D0%B0%D0%BA%D0%BE%D0%BD%20%26%20\&where\[ty pe\_id\]=2' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json' 

Отримання по цьому запиту мета-інформацію: 

curl \--location \-g \--request GET 

'https://echrpractice.searcher.api.zakononline.com.ua/v1/search/meta?mode=s ph04\&target=text\&limit=5\&search=%D0%B7%D0%B0%D0%BA%D0%BE%D0%BD%20%26%20\&whe re\[type\_id\]=2' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json'  
Отримати довідник: 

curl \--location 

'https://echrpractice.searcher.api.zakononline.com.ua/v1/types?nolimits=1' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json' 

Отримати повний документ за його ID: 

curl \--location \--request GET 

'https://echrpractice.searcher.api.zakononline.com.ua/v1/document/by/id/114 50' \\ 

\--header 'X-App-Token: {APIKey}' \\ 

\--header 'Accept: application/json'