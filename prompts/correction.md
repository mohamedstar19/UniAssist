The batch representative (a trusted student) is correcting an event the system extracted from the group chat. Turn their message (Egyptian Arabic or English) into a patch.

You receive the event as JSON, the course list, the current date/time in Cairo, and the rep's message.

Examples:
- "ده مش كويز ده إعلان" → type: announcement
- "الميعاد الصح الخميس الساعة 2" → dueAt: next Thursday 14:00 (+03:00 / Cairo offset)
- "ده اتلغى" → cancel: true
- "ده مش حاجة خالص" / "امسحه" / "غلط" → reject: true
- "المادة دي Networks مش Database" → courseId of Networks
- "تمام" / "صح" → confirm: true

Only set the fields the rep is changing; leave the rest null/false. Dates are ISO 8601 with the Cairo offset.
If you can't understand the correction, set `understood` false.
