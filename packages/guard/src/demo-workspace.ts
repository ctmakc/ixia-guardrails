import type { Workspace } from './types';

// Fictional firm used by the playground and the eval set. Every fact the
// model may state lives here; anything else it says is "not in KB".
export const DEMO_WORKSPACE: Workspace = {
  name: 'Demo Law Amsterdam',
  businessDesc: 'A fictional boutique law firm in Amsterdam for employment, family and skilled-migrant immigration matters. Clients write in Dutch, English, German, French, Spanish and Ukrainian.',
  slaMinutes: 30,
  bookingUrl: 'https://cal.example.com/demo-law',
  contactEmail: 'intake@demo-law.example',
  kb: [
    { id: 'areas', title: 'Practice areas', text: 'We handle employment law (dismissal, settlement agreements, contract review), family law (divorce, parenting plans, partner alimony) and immigration for highly skilled migrants and their families. We do not handle criminal defence or tax matters.' },
    { id: 'consult', title: 'First consultation', text: 'The first consultation takes 45 minutes, by video or at our office, and costs EUR 150 excluding VAT. If you instruct us afterwards, the EUR 150 is deducted from the first invoice.' },
    { id: 'contract_review', title: 'Fixed-fee employment contract or settlement review', text: 'We review an employment contract or a settlement agreement (vaststellingsovereenkomst) for a fixed fee of EUR 395 excluding VAT, with written comments within 3 working days.' },
    { id: 'hours', title: 'Office hours', text: 'Monday to Friday, 09:00 to 17:30 Amsterdam time. Enquiries outside office hours are answered the next working day.' },
    { id: 'languages', title: 'Languages', text: 'Our lawyers work in Dutch, English, German and French. Ukrainian and Spanish enquiries are answered by an intake colleague and an interpreter can join the consultation.' },
    { id: 'booking', title: 'How to book', text: 'Book a first consultation online at https://cal.example.com/demo-law or reply to this e-mail with two time slots that suit you.' },
    { id: 'documents', title: 'What to prepare', text: 'For employment matters bring your contract, recent payslips and any letters from your employer. For immigration matters bring your passport, current residence permit and employment contract. For family matters bring a short timeline.' },
    { id: 'legal_aid', title: 'Subsidised legal aid', text: 'We do not work under subsidised legal aid (toevoeging). The Juridisch Loket gives free first-line legal information.' },
    { id: 'privacy', title: 'Privacy', text: 'We use your details only to handle your enquiry. Please do not send medical records or identity documents before your consultation; we will ask for what we need through a secure upload link.' },
    { id: 'urgent', title: 'Urgent matters', text: 'If you have a court hearing or a deadline within 5 working days, mention it in your message; a lawyer reviews urgent enquiries first.' },
  ],
};
