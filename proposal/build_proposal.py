"""SpazaStock investor proposal (A4 PDF). Run from the repo root: python3 proposal/build_proposal.py proposal/SpazaStock-Investor-Proposal.pdf"""
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, KeepTogether, NextPageTemplate, Image)

OUT = sys.argv[1]
import os
LOGO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'pwa-512x512.png')
INK = colors.HexColor('#0F172A')
BODY = colors.HexColor('#334155')
MUTED = colors.HexColor('#64748B')
ACCENT = colors.HexColor('#16A34A')
LIGHT = colors.HexColor('#F1F5F9')
LINE = colors.HexColor('#E2E8F0')
TODO = colors.HexColor('#B45309')

W, H = A4
M = 20 * mm

s = {
    'h1': ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=20, leading=25, textColor=INK, spaceBefore=4, spaceAfter=10),
    'h2': ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=12.5, leading=16, textColor=INK, spaceBefore=10, spaceAfter=5),
    'body': ParagraphStyle('body', fontName='Helvetica', fontSize=10, leading=14.5, textColor=BODY, spaceAfter=7),
    'lead': ParagraphStyle('lead', fontName='Helvetica', fontSize=11.5, leading=17, textColor=INK, spaceAfter=9),
    'bullet': ParagraphStyle('bullet', fontName='Helvetica', fontSize=10, leading=14.5, textColor=BODY, leftIndent=12, bulletIndent=0, spaceAfter=3.5),
    'cell': ParagraphStyle('cell', fontName='Helvetica', fontSize=9, leading=12.5, textColor=BODY),
    'cellb': ParagraphStyle('cellb', fontName='Helvetica-Bold', fontSize=9, leading=12.5, textColor=INK),
    'kicker': ParagraphStyle('kicker', fontName='Helvetica-Bold', fontSize=8.5, leading=11, textColor=ACCENT, spaceAfter=2),
    'note': ParagraphStyle('note', fontName='Helvetica-Oblique', fontSize=8.5, leading=12, textColor=MUTED, spaceAfter=6),
    'stat': ParagraphStyle('stat', fontName='Helvetica-Bold', fontSize=20, leading=23, textColor=INK),
    'statl': ParagraphStyle('statl', fontName='Helvetica', fontSize=8.5, leading=11.5, textColor=MUTED),
}


def todo(text):
    return f'<font color="#B45309"><b>[{text}]</b></font>'


def P(text, style='body'):
    return Paragraph(text, s[style])


def bullets(items):
    return [Paragraph(i, s['bullet'], bulletText='•') for i in items]


def section(kicker, title):
    return [P(kicker.upper(), 'kicker'), P(title, 'h1')]


def table(rows, widths, header=True):
    data = [[Paragraph(str(c), s['cellb'] if (header and r == 0) or ci == 0 else s['cell'])
             for ci, c in enumerate(row)] for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LINEBELOW', (0, 0), (-1, -1), 0.5, LINE),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]
    if header:
        style += [('BACKGROUND', (0, 0), (-1, 0), LIGHT), ('LINEBELOW', (0, 0), (-1, 0), 1, INK)]
    t.setStyle(TableStyle(style))
    return t


def stats(items):
    cells = [[Paragraph(v, s['stat']), ] for v, _ in items]
    data = [[[Paragraph(v, s['stat']), Spacer(1, 3), Paragraph(l, s['statl'])] for v, l in items]]
    w = (W - 2 * M) / len(items)
    t = Table(data, colWidths=[w] * len(items))
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), LIGHT),
        ('LINEBEFORE', (1, 0), (-1, -1), 2, colors.white),
        ('TOPPADDING', (0, 0), (-1, -1), 10), ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('LEFTPADDING', (0, 0), (-1, -1), 10), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return t


def callout(text):
    t = Table([[Paragraph(text, s['lead'])]], colWidths=[W - 2 * M])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), LIGHT), ('LINEBEFORE', (0, 0), (0, -1), 3, ACCENT),
        ('LEFTPADDING', (0, 0), (-1, -1), 12), ('TOPPADDING', (0, 0), (-1, -1), 9),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return t


def cover(c, doc):
    c.saveState()
    c.setFillColor(INK)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(ACCENT)
    c.rect(0, H * 0.36, W, 3, stroke=0, fill=1)
    c.drawImage(LOGO, M, H - M - 26 * mm, 22 * mm, 22 * mm, mask='auto')
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 40)
    c.drawString(M, H * 0.58, 'SpazaStock')
    c.setFont('Helvetica', 17)
    c.setFillColor(colors.HexColor('#CBD5E1'))
    c.drawString(M, H * 0.58 - 26, 'Stock, expiry and sales control for South Africa’s spaza shops')
    c.setFont('Helvetica-Bold', 12)
    c.setFillColor(colors.HexColor('#86EFAC'))
    c.drawString(M, H * 0.58 - 62, 'INVESTMENT PROPOSAL')
    c.setFont('Helvetica', 10.5)
    c.setFillColor(colors.HexColor('#CBD5E1'))
    y = H * 0.36 - 30
    for line in ['Kasala Technologies', 'spazastock.kasalatechnologies.co.za', 'Draft — November 2026',
                 'Confidential: prepared for prospective investors']:
        c.drawString(M, y, line)
        y -= 16
    c.restoreState()


def page(c, doc):
    c.saveState()
    c.setStrokeColor(LINE)
    c.line(M, 14 * mm, W - M, 14 * mm)
    c.setFont('Helvetica', 8)
    c.setFillColor(MUTED)
    c.drawString(M, 9.5 * mm, 'SpazaStock — Investment proposal (draft, confidential)')
    c.drawRightString(W - M, 9.5 * mm, str(doc.page))
    c.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=M, rightMargin=M, topMargin=M, bottomMargin=22 * mm,
                      title='SpazaStock investment proposal', author='Kasala Technologies',
                      subject='Investment proposal (draft)')
frame = Frame(M, 22 * mm, W - 2 * M, H - M - 22 * mm, id='f', leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
doc.addPageTemplates([PageTemplate('cover', [frame], onPage=cover), PageTemplate('page', [frame], onPage=page)])

CW = W - 2 * M
st = [NextPageTemplate('page'), PageBreak()]

# 1. Executive summary
st += section('01', 'Executive summary')
st.append(callout('SpazaStock is a mobile app that lets a spaza shop owner know what is on the shelf, what is about '
                  'to expire and what sold today — on a cheap Android phone, in their own language, with or '
                  'without data.'))
st.append(Spacer(1, 8))
st.append(P('Spaza shops sell a large share of everyday groceries in South Africa’s townships and villages, yet '
            'almost all of them run on memory, notebooks and cash. Owners lose money to expired stock, shrinkage '
            'and slow-moving lines they cannot see. Since late 2024, when food-borne illness linked to informal '
            'food outlets led government to require spaza shops to register and meet health standards, '
            'selling expired food has also become a compliance risk.'))
st.append(P('SpazaStock is built and live. Owners scan barcodes to receive stock as expiry-dated batches, sell by '
            'scan, and get reminders before stock expires. It works fully offline, supports teams with owner, '
            'manager and worker roles, and runs in five languages used by spaza owners: English, isiZulu, '
            'Amharic, Somali and Bangla. A shared product catalogue means every new shop starts faster than the last.'))
st.append(P(f'We are raising {todo("amount, e.g. R X million")} to move from pilot to paid growth: field sales in '
            f'three metros, native-speaker localisation, payments and supplier ordering. The funds give us '
            f'{todo("runway, e.g. 18 months")} to reach {todo("target, e.g. N paying shops")}.'))
st.append(Spacer(1, 6))
st.append(stats([('Live', 'Product in production on Cloudflare'), ('Offline', 'Every sale and delivery works with no data'),
                 ('5', 'Languages in the app'), ('19', 'Pilot shops on the platform today')]))

# 2. Problem
st += [PageBreak()] + section('02', 'The problem')
st.append(P('A typical spaza shop carries a few hundred product lines, buys from wholesalers several times a week, '
            'and is run by the owner and one or two workers. Margins are thin, so every expired loaf, carton of '
            'milk or tin that has to be thrown away comes straight out of profit.', 'lead'))
st += bullets([
    '<b>Expiry losses are invisible.</b> Stock arrives in many deliveries with different dates. Nobody can '
    'remember which batch expires when, so old stock is found too late and written off.',
    '<b>Health and compliance risk.</b> Selling expired or unsafe food can now cost a shop its registration, '
    'its reputation and in the worst case lives. Owners need proof they manage expiry.',
    '<b>No view of the business.</b> Without records, owners cannot see which lines make money, how much stock '
    'is on hand, or whether workers’ sales match the till.',
    '<b>Existing tools don’t fit.</b> Retail point-of-sale systems assume a laptop, stable internet, '
    'English-only staff and a monthly fee sized for formal retail. Spaza owners have a mid-range Android phone '
    'and expensive mobile data.',
    '<b>Credit and supply are locked out.</b> Lenders and suppliers cannot extend credit to a shop with no '
    'trading history. Digital records are the first step to both.',
])

# 3. Solution
st += [Spacer(1, 6)] + section('03', 'The solution')
st.append(P('SpazaStock turns the owner’s phone into a stock and expiry system that takes seconds per action.'))
st.append(table([
    ['Capability', 'What the owner gets'],
    ['Scan to receive stock', 'Each delivery is a batch with its own expiry date. Cases and packs are converted to units automatically.'],
    ['Scan to sell', 'Rapid scan-to-sell keeps the camera open; each scan is a sale. Stock is taken first-expired-first-out.'],
    ['Expiry alerts', 'Reminders at 21, 14 and 7 days (adjustable) and an overdue alert, as push notifications even when the app is closed.'],
    ['Write-offs with an audit trail', 'Expired stock is resolved as thrown away, returned to supplier or wrong date, with who did it and when.'],
    ['Works offline', 'Everything is saved on the phone first and syncs when data returns. Nothing is lost and nothing is counted twice.'],
    ['Teams', 'Owners invite workers and managers by WhatsApp link, with permissions per role. Access can be removed instantly.'],
    ['Shared catalogue', 'A barcode registered by one shop pre-fills the name, brand, size and picture for the next shop.'],
    ['Five languages', 'English, isiZulu, Amharic, Somali and Bangla, chosen from the phone’s language.'],
    ['Android app and web', 'Install from Google Play (in preparation) or add to the home screen from the browser.'],
], [45 * mm, CW - 45 * mm]))

# 4. Market
st += [PageBreak()] + section('04', 'Market opportunity')
st.append(P('The spaza sector is one of the largest retail channels in South Africa by number of outlets, and the '
            'main grocery channel for many township and rural households. Common estimates put the number of '
            f'spaza shops at roughly 100,000 to 150,000 {todo("verify with a current source, e.g. government registration data")}, '
            'with many more informal food traders.'))
st.append(table([
    ['Layer', 'Definition', 'Estimate'],
    ['Total market', 'All spaza and informal grocery outlets in South Africa', f'~100,000–150,000 shops {todo("verify")}'],
    ['Serviceable market', 'Shops with a smartphone, selling barcoded goods, in metros and large towns', f'{todo("estimate, e.g. 40–60% of total")}'],
    ['Initial target', 'Shops in Gauteng, Western Cape and KwaZulu-Natal metros reached by field agents and wholesaler partners', f'{todo("e.g. 5,000 shops in 3 years")}'],
], [32 * mm, 85 * mm, CW - 117 * mm]))
st.append(Spacer(1, 8))
st.append(P('<b>Why now</b>', 'h2'))
st += bullets([
    'Municipal registration and health inspections of spaza shops create a direct need for expiry records.',
    'Affordable Android phones are now standard among shop owners and workers.',
    'Wholesalers, FMCG brands and lenders all want data from this channel and have no clean way to get it.',
    'Serverless cloud infrastructure means each additional shop costs very little to serve, so a low price can still be profitable.',
])
st.append(P('<b>Expansion beyond South Africa</b>', 'h2'))
st.append(P('Many spaza owners are from Ethiopia, Somalia and Bangladesh, which is why the app already speaks their '
            'languages. The same informal-retail model exists across Southern and East Africa, giving a path to '
            'neighbouring markets once the South African playbook is proven.'))

# 5. Business model
st += [PageBreak()] + section('05', 'Business model')
st.append(P('A freemium subscription, with further revenue from the data and transactions that flow through the platform. '
            'The plan and billing system (free and Pro plans, trials, grace periods, per-plan limits) is already built into the product.'))
st.append(table([
    ['Revenue stream', 'How it works', 'Status'],
    ['Free plan', 'Stock, sales and expiry for one shop with limits on team size and features. Drives adoption.', 'Live'],
    ['Pro subscription', f'Monthly fee per shop for teams, push alerts, multiple shops and reports. 14-day free trial. Price {todo("e.g. R99–R199 / month")}.', 'Built, pricing to set'],
    ['Wholesaler and brand partnerships', 'Anonymised, aggregated sell-through and expiry data by area; promotions to shops that opt in.', 'Planned'],
    ['Supplier ordering', 'Reorder from partner wholesalers inside the app; commission on orders.', 'Planned'],
    ['Financial services referrals', 'Trading history helps shops qualify for stock credit and loans from partners; referral fee.', 'Planned'],
], [42 * mm, CW - 42 * mm - 30 * mm, 30 * mm]))

# 6. Traction & product
st += [Spacer(1, 8)] + section('06', 'Traction and product status')
st += bullets([
    '<b>Live product</b> at spazastock.kasalatechnologies.co.za, used by 19 pilot shops and 19 registered users.',
    '<b>Production-grade platform</b>: migrated in November 2026 to Cloudflare (Workers, D1, Durable Objects, R2), '
    'with each shop’s ledger in its own isolated database, automated alerts and push notifications.',
    '<b>Android app</b> (package za.co.kasalatechnologies.spazastock) built and ready for Google Play submission.',
    '<b>Shared catalogue</b> of more than 300 products and barcodes, linked to the Open Food Facts database.',
    '<b>Admin console</b> for support, billing and analytics staff, with role-based permissions and audit logs.',
])
st.append(P(f'{todo("Add pilot results: e.g. sales recorded, expired stock caught, owner testimonials, retention")}', 'body'))
st.append(P('<b>What makes SpazaStock hard to copy</b>', 'h2'))
st += bullets([
    '<b>Built offline-first</b>, not adapted later: sales from two phones selling the last unit offline are reconciled, never lost.',
    '<b>Expiry at batch level</b>, which general point-of-sale apps do not track.',
    '<b>Network effect in the catalogue</b>: every shop that scans a new product makes onboarding faster for the next.',
    '<b>Languages and design for the actual owners</b> of spaza shops, including immigrant owners.',
    '<b>Very low cost to serve</b> per shop, so the free tier is sustainable and paid plans carry high gross margin.',
])

# 7. Go-to-market
st += [PageBreak()] + section('07', 'Go-to-market')
st.append(table([
    ['Channel', 'Approach'],
    ['Field agents', 'Local agents onboard shops in person in target townships, paid per active shop. Owners trust people they meet.'],
    ['Wholesaler partners', 'Cash-and-carry wholesalers recommend SpazaStock to their spaza customers; co-branded onboarding at the counter.'],
    ['Community and associations', 'Spaza owner associations, immigrant business networks and WhatsApp groups in each language.'],
    ['Referral', 'Owners who invite other shops get free Pro months.'],
    ['Compliance angle', 'Position expiry records as support for municipal registration and health inspections.'],
], [42 * mm, CW - 42 * mm]))

# 8. Roadmap
st += [Spacer(1, 8)] + section('08', 'Roadmap')
st.append(table([
    ['Period', 'Milestones'],
    [f'Next 6 months {todo("dates")}', 'Google Play launch; Pro pricing and payments; native-speaker review of all languages; field pilot in one metro.'],
    ['6–12 months', 'Sales and profit reports; supplier price lists; wholesaler partnership pilot; expansion to three metros.'],
    ['12–24 months', 'In-app reordering from wholesalers; stock-credit partner integration; aggregated data product for brands; first market outside South Africa.'],
], [42 * mm, CW - 42 * mm]))

# 9. Team
st += [PageBreak()] + section('09', 'Team')
st.append(P(f'{todo("Founder name")} — Founder, Kasala Technologies. {todo("Background, relevant experience, why you are building this")}'))
st.append(P(f'{todo("Other team members, advisors and the roles you plan to hire: e.g. head of field sales, customer support in isiZulu and Amharic")}'))

# 10. The ask
st += [Spacer(1, 4)] + section('10', 'The investment')
st.append(P(f'We are raising <b>{todo("amount")}</b> as {todo("instrument, e.g. equity / SAFE / convertible note")} '
            f'at {todo("valuation or terms")}. Proposed use of funds:'))
st.append(table([
    ['Use', 'Share', 'What it pays for'],
    ['Sales and onboarding', f'40% {todo("adjust")}', 'Field agents, wholesaler partnerships, onboarding materials in five languages.'],
    ['Product and engineering', f'30% {todo("adjust")}', 'Payments, reports, supplier ordering, Play Store launch, quality and security.'],
    ['Customer support and localisation', f'15% {todo("adjust")}', 'Support in local languages; native-speaker translation review.'],
    ['Operations and working capital', f'15% {todo("adjust")}', 'Infrastructure, legal, compliance, administration.'],
], [48 * mm, 32 * mm, CW - 80 * mm]))
st.append(Spacer(1, 6))
st.append(P('<b>Financial projections</b>', 'h2'))
st.append(table([
    ['', 'Year 1', 'Year 2', 'Year 3'],
    ['Active shops', todo('n'), todo('n'), todo('n')],
    ['Paying shops', todo('n'), todo('n'), todo('n')],
    ['Revenue (ZAR)', todo('R'), todo('R'), todo('R')],
    ['Operating costs (ZAR)', todo('R'), todo('R'), todo('R')],
], [52 * mm] + [(CW - 52 * mm) / 3] * 3))
st.append(P('Projections to be completed from the pilot conversion rate, chosen Pro price and the hiring plan.', 'note'))

# 11. Risks
st += [PageBreak()] + section('11', 'Risks and how we manage them')
st.append(table([
    ['Risk', 'Mitigation'],
    ['Owners are slow to adopt new technology', 'Free plan, in-person onboarding, local languages, and a first useful result (expiry reminders) within days.'],
    ['Willingness to pay is low', 'Price against money saved on expired stock; keep cost to serve very low; add revenue from partners, not only subscriptions.'],
    ['Unreliable data and power', 'Offline-first design: the app works with no connection and syncs later without losing data.'],
    ['Competition from POS and wholesaler apps', 'Focus on expiry, offline use and languages; partner with wholesalers rather than compete.'],
    ['Data protection (POPIA)', 'Each shop’s data is private to its members; role-based access; audit logs; aggregated data only shared anonymised and with consent.'],
], [55 * mm, CW - 55 * mm]))

# 12. Contact
st += [Spacer(1, 10)] + section('12', 'Contact')
st.append(P('<b>Kasala Technologies</b>'))
st.append(P(f'{todo("Name, title")}<br/>{todo("Email")}<br/>{todo("Phone")}<br/>Product: spazastock.kasalatechnologies.co.za'))
st.append(Spacer(1, 10))
st.append(P('This document is a draft for discussion. Market figures marked for verification are estimates and should '
            'be confirmed before distribution. It does not constitute an offer of securities.', 'note'))

doc.build(st)
print('ok', OUT)
