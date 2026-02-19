/**
 * SecondLayer Maintenance Mode Worker
 * Served by Cloudflare edge during backend redeployment.
 * Returns HTTP 503 with a branded bilingual maintenance page.
 */

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>SecondLayer — Технічне обслуговування / Maintenance</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      min-height: 100vh;
      background: #F5F5F0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #2D2D2D;
    }

    .container {
      text-align: center;
      padding: 3rem 2rem;
      max-width: 540px;
      width: 100%;
    }

    .logo-wrap {
      display: block;
      margin: 0 auto 2rem;
      width: 88px;
      height: 88px;
      border-radius: 50%;
      object-fit: cover;
      animation: breathe 3.5s ease-in-out infinite;
    }

    @keyframes breathe {
      0%, 100% { transform: scale(1);   opacity: 1;    }
      50%       { transform: scale(.96); opacity: .75; }
    }

    .brand {
      font-family: 'Crimson Pro', Georgia, 'Times New Roman', serif;
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: #2D2D2D;
      margin-bottom: 2rem;
    }
    .brand em { color: #D97757; font-style: normal; }

    .divider {
      width: 44px;
      height: 2px;
      background: linear-gradient(90deg, #D97757, #E8A07D);
      margin: 0 auto 2.25rem;
      border-radius: 2px;
    }

    .msg-en {
      font-family: 'Crimson Pro', Georgia, serif;
      font-size: 2.4rem;
      font-weight: 600;
      line-height: 1.15;
      color: #2D2D2D;
      margin-bottom: .6rem;
    }

    .msg-uk {
      font-family: 'Crimson Pro', Georgia, serif;
      font-size: 1.9rem;
      font-weight: 400;
      font-style: italic;
      line-height: 1.25;
      color: #6B6B6B;
      margin-bottom: 2.25rem;
    }

    .sub {
      font-size: .875rem;
      color: #888;
      line-height: 1.8;
    }

    .dots {
      display: inline-flex;
      gap: 7px;
      margin-top: 2.5rem;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #D97757;
      animation: bounce 1.5s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: .22s; }
    .dot:nth-child(3) { animation-delay: .44s; }

    @keyframes bounce {
      0%, 80%, 100% { transform: scale(.55); opacity: .35; }
      40%           { transform: scale(1);   opacity: 1;   }
    }

    @media (max-width: 480px) {
      .msg-en { font-size: 1.9rem; }
      .msg-uk { font-size: 1.5rem; }
    }
  </style>
</head>
<body>
  <div class="container">

    <img class="logo-wrap" src="https://legal.org.ua/Image.jpg" alt="SecondLayer">

    <div class="brand">Second<em>Layer</em></div>
    <div class="divider"></div>

    <div class="msg-en">We'll be right back!</div>
    <div class="msg-uk">Ми незабаром повернемося!</div>

    <p class="sub">
      Scheduled system update in progress.<br>
      Виконується планове оновлення системи.
    </p>

    <div class="dots">
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    </div>

  </div>
</body>
</html>`;

addEventListener('fetch', event => {
  event.respondWith(
    new Response(MAINTENANCE_HTML, {
      status: 503,
      headers: {
        'Content-Type':  'text/html; charset=UTF-8',
        'Retry-After':   '300',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Robots-Tag':  'noindex, nofollow',
      },
    })
  );
});
