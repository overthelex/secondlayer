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
      margin: 0 auto 2rem;
      width: 88px;
      height: 88px;
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

    <!-- Scales of Justice icon (inline SVG, no external deps) -->
    <svg class="logo-wrap" viewBox="0 0 88 88" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SecondLayer">
      <!-- Background circle -->
      <circle cx="44" cy="44" r="42" fill="#EDECEA" stroke="#E0DDD9" stroke-width="1.5"/>

      <!-- Pole -->
      <rect x="42.5" y="20" width="3" height="42" rx="1.5" fill="#2D2D2D"/>

      <!-- Pivot cap -->
      <circle cx="44" cy="20" r="4" fill="#D97757"/>

      <!-- Horizontal beam -->
      <rect x="18" y="31" width="52" height="3" rx="1.5" fill="#2D2D2D"/>

      <!-- Left suspension line -->
      <line x1="24" y1="34" x2="24" y2="44" stroke="#2D2D2D" stroke-width="1.8" stroke-linecap="round"/>
      <!-- Right suspension line (slightly shorter → right pan higher) -->
      <line x1="64" y1="34" x2="64" y2="41" stroke="#2D2D2D" stroke-width="1.8" stroke-linecap="round"/>

      <!-- Left pan (lower) -->
      <path d="M 16 46 Q 24 54 32 46" stroke="#D97757" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <!-- Right pan (higher) -->
      <path d="M 56 43 Q 64 51 72 43" stroke="#2D2D2D" stroke-width="2.2" fill="none" stroke-linecap="round" opacity=".55"/>

      <!-- Base foot -->
      <rect x="34" y="62" width="20" height="3.5" rx="1.75" fill="#2D2D2D"/>
      <rect x="29" y="65.5" width="30" height="2.5" rx="1.25" fill="#2D2D2D"/>
    </svg>

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
