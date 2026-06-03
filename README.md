# EVO Events Telegram Bot

A Telegram bot that mentions everyone in a group chat using `@all` or the `/all` command, built with [grammY](https://grammy.dev/).

## Features

- Trigger with `/all` command or `@all` text
- Attach an optional message: `@all Don't forget the meeting at 5pm!`
- Tracks members as they send messages and when they join the group
- Handles large groups by splitting long mention lists across multiple messages
- Supports users without a username via Telegram text-mention links

## Limitation

Telegram's Bot API does not provide an endpoint to list all group members. The bot can only mention users it has **observed** — members who have sent at least one message (or joined) while the bot was running. Silent/lurker members who never interacted will not be mentioned.

## Requirements

- [Node.js](https://nodejs.org/) v18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/olekpuchka/EVO-events.git
   cd EVO-events
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set your bot token:

   ```env
   BOT_TOKEN=your_telegram_bot_token_here
   ```

4. **Run the bot**

   ```bash
   # Production
   npm start

   # Development (auto-restarts on file changes)
   npm run dev
   ```

## Usage

Add the bot to your Telegram group, then:

| Trigger | Effect |
|---|---|
| `/all` | Mentions all tracked members |
| `/all <message>` | Mentions all members + appends your message |
| `@all` | Same as `/all` (requires privacy mode off) |
| `@all <message>` | Same as `/all <message>` (requires privacy mode off) |

### Enabling `@all` text trigger

By default, Telegram bots only receive messages directed at them. To allow the bot to read all messages and respond to `@all`:

1. Open a chat with [@BotFather](https://t.me/BotFather)
2. Send `/setprivacy`
3. Select your bot
4. Choose **Disable**

> The `/all` command always works regardless of privacy mode.

## Production Deployment (JustRunMy.App)

[JustRunMy.App](https://justrunmy.app/telegram-bots) offers always-on container hosting with a free tier — no VPS setup or SSH required.

### 1. Create an app on JustRunMy.App

1. Sign up at [justrunmy.app](https://justrunmy.app)
2. Create a new app → choose **Docker Registry Push**
3. In the app's **Environment** tab, add:
   - `BOT_TOKEN` = your Telegram bot token
4. In the app's **Docker Registry Push** tab, copy the **registry URL**, **username**, and **token**

### 2. GitHub Secrets required

Go to **GitHub → Settings → Secrets and variables → Actions** and add:

| Secret | Where to get it |
|---|---|
| `BOT_TOKEN` | [@BotFather](https://t.me/BotFather) on Telegram |
| `JRMA_REGISTRY` | App panel → Docker Registry Push tab (registry URL) |
| `JRMA_USERNAME` | App panel → Docker Registry Push tab |
| `JRMA_TOKEN` | App panel → Docker Registry Push tab |

### 3. Auto-deploy

Every push to `master` triggers [.github/workflows/deploy.yml](.github/workflows/deploy.yml), which builds the Docker image and pushes it to JustRunMy.App. The platform detects the new image and redeploys automatically.

## Project Structure

```
EVO-events/
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Actions CI/CD
├── bot.js                   # Main bot logic
├── Dockerfile               # Container definition
├── .dockerignore
├── package.json
├── .env.example             # Environment variable template
├── .gitignore
└── README.md
```

## License

[MIT](LICENSE)
