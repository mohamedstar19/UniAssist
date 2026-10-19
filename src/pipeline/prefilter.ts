/**
 * Cheap filter that runs before any LLM call. Group chats are mostly greetings,
 * memes and chatter; only messages with a file, a date, or a study keyword are
 * worth classifying. Tuned to let borderline messages through (a missed
 * assignment is worse than a wasted Haiku call).
 */

const KEYWORDS = [
  // Arabic (Egyptian spelling variants included)
  "اسايمنت", "أسايمنت", "اسيمنت", "أسيمنت", "تكليف", "واجب", "كويز", "كويزات", "امتحان", "إمتحان", "امتحانات",
  "ميد", "ميدترم", "فاينال", "نهائي", "عملي", "شفوي", "تسليم", "يتسلم", "هيتسلم", "ديدلاين", "شيت", "سكشن",
  "محاضرة", "المحاضرة", "محاضره", "لاب", "معمل", "تأجيل", "اتأجل", "أتأجل", "اتلغى", "إلغاء", "الغاء", "ملغي",
  "موعد", "ميعاد", "مشروع", "بروجكت", "تقرير", "ريبورت", "برزنتيشن", "عرض", "سلايدات", "سلايد", "ملزمة",
  "الدكتور", "دكتور", "الدكتورة", "المعيد", "المعيدة", "د/", "د.", "م/", "م.", "درجات", "أعمال سنة", "حضور",
  "جدول", "قاعة", "مدرج", "اونلاين", "أونلاين", "زووم", "تيمز", "بدل",
  // English
  "assignment", "assign", "quiz", "exam", "midterm", "mid-term", "final", "deadline", "due", "submit",
  "submission", "sheet", "section", "lecture", "lab", "project", "report", "presentation", "slides", "postponed",
  "cancelled", "canceled", "moved", "room", "hall", "zoom", "teams", "dr.", "dr ", "eng.", "ta ",
];

const DATE_PATTERNS: RegExp[] = [
  /\d{1,2}\s*[\/\-.]\s*\d{1,2}/, // 22/10, 22-10
  /(السبت|الأحد|الاحد|الحد|الاتنين|الإثنين|الاثنين|التلات|الثلاثاء|التلاتاء|الأربع|الاربع|الأربعاء|الاربعاء|الخميس|الجمعة|الجمعه)/,
  /(بكرة|بكره|النهارده|النهاردة|بعد بكرة|بعد بكره|الأسبوع الجاي|الاسبوع الجاي|الأسبوع اللي جاي|الاسبوع اللي جاي)/,
  /(الساعة|الساعه)\s*\d/,
  /\d{1,2}(:\d{2})?\s*(am|pm|ص|م)\b/i,
  /\b(sat|sun|mon|tue|wed|thu|fri)[a-z]*\b/i,
  /\b(tomorrow|today|tonight|next week)\b/i,
  /(يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)/,
];

/** Arabic text normalisation so keyword checks survive common spelling differences. */
export function normalizeArabic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "") // diacritics + tatweel
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

const NORMALIZED_KEYWORDS = KEYWORDS.map(normalizeArabic);

export interface PrefilterInput {
  text: string;
  hasMedia: boolean;
  isReplyToTrackedMessage: boolean;
  senderIsInstructor: boolean;
}

export function shouldClassify(input: PrefilterInput): boolean {
  if (input.hasMedia) return true;
  if (input.isReplyToTrackedMessage) return true;
  const text = input.text.trim();
  if (text.length < 6) return false;
  if (input.senderIsInstructor && text.length >= 15) return true;
  if (text.length > 280) return true;
  const norm = normalizeArabic(text);
  if (NORMALIZED_KEYWORDS.some((k) => norm.includes(k))) return true;
  return DATE_PATTERNS.some((re) => re.test(text) || re.test(norm));
}
