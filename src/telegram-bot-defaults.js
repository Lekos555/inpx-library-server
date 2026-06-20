/** Тексты Telegram-бота по умолчанию (профиль, /start) и структура меню команд. */

/** Секции меню «/» — порядок секций и команд сохраняется в Telegram. */
export const BOT_MENU_SECTIONS = [
  {
    title: 'Основное',
    commands: [
      { command: 'start', description: 'Приветствие' },
      { command: 'help', description: 'Справка по командам' },
    ],
  },
  {
    title: 'Поиск',
    commands: [
      { command: 'search', description: 'Поиск книг', example: 'Толстой война мир' },
      { command: 'author', description: 'Поиск автора', example: 'Кораблев' },
      { command: 'series', description: 'Поиск серии', example: 'другая сторона' },
    ],
  },
  {
    title: 'Личное',
    hint: 'нужна привязка на сайте',
    commands: [
      { command: 'shelves', description: 'Мои полки' },
      { command: 'favorites', description: 'Избранное' },
      { command: 'recommended', description: 'Рекомендации' },
    ],
  },
  {
    title: 'Аккаунт',
    commands: [
      { command: 'me', description: 'Статус привязки' },
      { command: 'unlink', description: 'Отвязать Telegram' },
    ],
  },
];

export function flattenBotMenuCommands() {
  return BOT_MENU_SECTIONS.flatMap((section) => section.commands.map(({ command, description }) => ({
    command,
    description,
  })));
}

export function buildBotProfileDescription() {
  const parts = BOT_MENU_SECTIONS.map((section) => {
    const lines = section.commands.map(({ command, description }) => `/${command} - ${description}`);
    return `${section.title}:\n${lines.join('\n')}`;
  });
  return parts.join('\n\n').slice(0, 512);
}

export const TELEGRAM_DEFAULT_PROFILE_DESCRIPTION = buildBotProfileDescription();

export const TELEGRAM_DEFAULT_PROFILE_SHORT =
  'Книжный бот: поиск, скачивание, полки и рекомендации';

export const TELEGRAM_DEFAULT_WELCOME =
  '📚 <b>Библиотека книг</b>\n\n' +
  'Напишите автора, серию или книгу — бот сам определит, что искать.\n\n' +
  '<b>Поиск:</b> <code>/search</code> · <code>/author</code> · <code>/series</code>\n' +
  '<b>Личное:</b> <code>/shelves</code> · <code>/favorites</code> · <code>/recommended</code> <i>(после привязки)</i>\n\n' +
  '<code>/help</code> — полная справка';
