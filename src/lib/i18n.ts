export type Lang = 'ru' | 'he'

export const translations = {
  ru: {
    // Общее
    appName: 'Kassa',
    loading: 'Загрузка...',
    save: 'Сохранить',
    cancel: 'Отмена',
    back: 'Назад',
    error: 'Ошибка',

    // Настройка устройства
    deviceSetup: 'Настройка кассы',
    deviceSetupHint: 'Войдите в аккаунт вашей кофейни. Это делается один раз на каждом устройстве.',
    email: 'Email',
    password: 'Пароль',
    signIn: 'Войти',
    signUp: 'Создать аккаунт',
    signingIn: 'Входим...',
    noAccount: 'Нет аккаунта?',
    haveAccount: 'Уже есть аккаунт?',

    // Онбординг организации
    orgSetup: 'Новая кофейня',
    orgSetupHint: 'Расскажите о вашем заведении — это займёт минуту.',
    orgName: 'Название бизнеса',
    orgNamePlaceholder: 'Например: Дом Кофе',
    locationName: 'Название точки',
    locationNamePlaceholder: 'Например: Дизенгоф 50',
    ownerName: 'Ваше имя',
    ownerNamePlaceholder: 'Имя владельца',
    ownerPin: 'Ваш PIN-код (4 цифры)',
    createOrg: 'Начать работу',
    creating: 'Создаём...',

    // PIN-вход
    enterPin: 'Введите PIN-код',
    wrongPin: 'Неверный PIN-код',
    checking: 'Проверка...',

    // Роли
    owner: 'Владелец',
    manager: 'Менеджер',
    barista: 'Бариста',

    // Главный экран
    hello: 'Привет',
    lock: 'Блокировка',
    sell: 'Продажа',
    queue: 'Очередь',
    menu: 'Меню',
    reports: 'Отчёты',
    settings: 'Настройки',
    comingSoon: 'Скоро',
    signOutDevice: 'Отвязать устройство',

    // Админка меню
    items: 'Товары',
    categories: 'Категории',
    modifiersTab: 'Модификаторы',
    stations: 'Станции',
    newItem: 'Новый товар',
    editItem: 'Редактировать товар',
    itemName: 'Название',
    itemPrice: 'Цена, ₪',
    category: 'Категория',
    station: 'Станция',
    noStation: 'Без станции',
    available: 'В продаже',
    unavailable: 'Скрыт',
    askModifiers: 'Сразу открывать модификаторы',
    variants: 'Размеры / варианты',
    addVariant: '+ Размер',
    variantName: 'Название (S/M/L...)',
    defaultLabel: 'По умолч.',
    modifierGroups: 'Группы модификаторов',
    newCategory: 'Новая категория',
    categoryName: 'Название категории',
    newGroup: 'Новая группа',
    groupName: 'Название группы',
    minSelect: 'Мин. выбор',
    maxSelect: 'Макс. выбор (0 = без лимита)',
    addModifier: '+ Опция',
    modifierName: 'Название опции',
    priceDelta: '± Цена, ₪',
    newStation: 'Новая станция',
    stationName: 'Название станции',
    delete: 'Удалить',
    add: 'Добавить',
    noCategoriesYet: 'Создайте первую категорию',
    noItemsYet: 'В этой категории пока пусто',
    confirmDelete: 'Точно удалить?',
    saved: 'Сохранено',
    deleted: 'Удалено',
    itemsShort: 'товаров',
  },
  he: {
    // Общее
    appName: 'Kassa',
    loading: 'טוען...',
    save: 'שמור',
    cancel: 'ביטול',
    back: 'חזרה',
    error: 'שגיאה',

    // Настройка устройства
    deviceSetup: 'הגדרת הקופה',
    deviceSetupHint: 'התחברו לחשבון בית הקפה שלכם. פעולה חד-פעמית לכל מכשיר.',
    email: 'אימייל',
    password: 'סיסמה',
    signIn: 'התחברות',
    signUp: 'יצירת חשבון',
    signingIn: 'מתחברים...',
    noAccount: 'אין חשבון?',
    haveAccount: 'כבר יש חשבון?',

    // Онбординг организации
    orgSetup: 'בית קפה חדש',
    orgSetupHint: 'ספרו לנו על העסק שלכם — זה ייקח דקה.',
    orgName: 'שם העסק',
    orgNamePlaceholder: 'לדוגמה: בית הקפה',
    locationName: 'שם הסניף',
    locationNamePlaceholder: 'לדוגמה: דיזנגוף 50',
    ownerName: 'השם שלך',
    ownerNamePlaceholder: 'שם הבעלים',
    ownerPin: 'קוד PIN שלך (4 ספרות)',
    createOrg: 'להתחיל לעבוד',
    creating: 'יוצרים...',

    // PIN-вход
    enterPin: 'הזן קוד PIN',
    wrongPin: 'קוד PIN שגוי',
    checking: 'בודקים...',

    // Роли
    owner: 'בעלים',
    manager: 'מנהל',
    barista: 'בריסטה',

    // Главный экран
    hello: 'שלום',
    lock: 'נעילה',
    sell: 'מכירה',
    queue: 'תור',
    menu: 'תפריט',
    reports: 'דוחות',
    settings: 'הגדרות',
    comingSoon: 'בקרוב',
    signOutDevice: 'ניתוק המכשיר',

    // Админка меню
    items: 'פריטים',
    categories: 'קטגוריות',
    modifiersTab: 'תוספות',
    stations: 'עמדות',
    newItem: 'פריט חדש',
    editItem: 'עריכת פריט',
    itemName: 'שם',
    itemPrice: 'מחיר, ₪',
    category: 'קטגוריה',
    station: 'עמדה',
    noStation: 'ללא עמדה',
    available: 'במכירה',
    unavailable: 'מוסתר',
    askModifiers: 'לפתוח תוספות מיד',
    variants: 'גדלים / וריאציות',
    addVariant: '+ גודל',
    variantName: 'שם (S/M/L...)',
    defaultLabel: 'ברירת מחדל',
    modifierGroups: 'קבוצות תוספות',
    newCategory: 'קטגוריה חדשה',
    categoryName: 'שם הקטגוריה',
    newGroup: 'קבוצה חדשה',
    groupName: 'שם הקבוצה',
    minSelect: 'בחירה מינ.',
    maxSelect: 'בחירה מקס. (0 = ללא הגבלה)',
    addModifier: '+ אפשרות',
    modifierName: 'שם האפשרות',
    priceDelta: '± מחיר, ₪',
    newStation: 'עמדה חדשה',
    stationName: 'שם העמדה',
    delete: 'מחיקה',
    add: 'הוספה',
    noCategoriesYet: 'צרו את הקטגוריה הראשונה',
    noItemsYet: 'הקטגוריה הזו ריקה',
    confirmDelete: 'למחוק?',
    saved: 'נשמר',
    deleted: 'נמחק',
    itemsShort: 'פריטים',
  },
} as const

export type TranslationKey = keyof typeof translations.ru

export function t(lang: Lang, key: TranslationKey): string {
  return translations[lang][key] ?? translations.ru[key] ?? key
}

export function formatDate(date: string | Date, lang: Lang): string {
  return new Date(date).toLocaleString(lang === 'he' ? 'he-IL' : 'ru-RU')
}
