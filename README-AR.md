# تحكم: دليل التشغيل على سيرفر مستأجر

هذه الخطوات تشغل نظام تحكم على سيرفر صغير (VPS) خلال نحو 30 دقيقة. جربت على Ubuntu 24.04.

## 1. استأجر سيرفر
أي مزود (مثل Contabo أو Hetzner أو Oracle Cloud): أصغر باقة (1 CPU و2GB رام) تكفي للبداية، وتكلف نحو 15 إلى 30 ريالا شهريا. اختر أوبونتو 24.04.

## 2. ثبت Node.js 22
```
sudo apt update && sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node --version   # يجب أن يظهر v22
```

## 3. انسخ المشروع وشغله
```
git clone <رابط المستودع> tahakkum
cd tahakkum
openssl rand -hex 32   # انسخ الناتج، هذا المفتاح الرئيسي
```
أنشئ ملف البيئة:
```
sudo mkdir -p /etc
sudo nano /etc/tahakkum.env
```
ضع فيه (استبدل القيم):
```
MASTER_KEY=<ناتج openssl أعلاه>
PORT=8080
OWNER_EMAIL=<بريدك>
OWNER_PASSWORD=<كلمة مرور قوية للمالك>
```
ثم:
```
sudo chmod 600 /etc/tahakkum.env
set -a; source /etc/tahakkum.env; set +a
node src/seed.js     # ينشئ حساب المالك والبراندات التجريبية
node src/server.js   # يجب أن يقول listening on :8080
```
افتح `http://<عنوان-السيرفر>:8080` وجرب الدخول.

## 4. شغله دائما (systemd)
```
sudo nano /etc/systemd/system/tahakkum.service
```
```
[Unit]
Description=Tahakkum
After=network.target
[Service]
EnvironmentFile=/etc/tahakkum.env
WorkingDirectory=/root/tahakkum
ExecStart=/usr/bin/node src/server.js
Restart=always
[Install]
WantedBy=multi-user.target
```
```
sudo systemctl enable --now tahakkum
```

## 5. HTTPS بدومينك (Caddy)
بعد ربط الدومين بعنوان السيرفر:
```
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```
```
tahakkum.app {
    reverse_proxy 127.0.0.1:8080
}
```
```
sudo systemctl reload caddy
```
كادي يصدر الشهادة تلقائيا. بعدها الموقع يعمل على `https://tahakkum.app`.

## 6. نسخ احتياطي يومي
```
crontab -e
```
```
0 4 * * * cp /root/tahakkum/data/tahakkum.json /root/backups/tahakkum-$(date +\%F).json
```
أبق نسخة من MASTER_KEY في مكان آمن غير السيرفر. بدونه لا يمكن فك باسووردات التجار المخزنة.

## الاستضافة المجانية بدون كارت بنكي (Render + Turso)
- أنشئ قاعدة Turso مجانية (turso.tech، تسجيل بالبريد فقط) وانسخ TURSO_URL و TURSO_TOKEN.
- انشر على Render كخدمة ويب مجانية من رابط المستودع العام (بدون ربط حساب GitHub)، مع متغيرات البيئة: MASTER_KEY و TURSO_URL و TURSO_TOKEN و OWNER_EMAIL و OWNER_PASSWORD. أمر البناء: npm install، وأمر التشغيل: node src/server.js.
- ملاحظة: الخدمة المجانية تنام بعد 15 دقيقة بلا زيارات وتستيقظ عند أول طلب (بطيء أول مرة). بدون TURSO_URL يعود النظام لقاعدة ملف محلية على القرص (مناسبة للسيرفر الافتراضي فقط).

## تفعيل الموصلات الرسمية
الموصلات الرسمية معطلة افتراضيا وتفعل بمتغيرات البيئة في /etc/tahakkum.env:
- HS_OFFICIAL=1 يفعل موصل هنقرستيشن الرسمي (يحتاج client_id و client_secret من بوابة الشركاء، ويخزنان في الخزنة بصيغة id:secret واسم المستخدم هو chainID). تأكد أولا من HS_API_BASE و HS_TOKEN_PATH و HS_ORDERS_PATH مقابل مواصفة OpenAPI الرسمية.
- TY_OFFICIAL=1 يفعل موصل تويو الرسمي (اسم المستخدم وكلمة المرور الخاصان بالتاجر على app.toyou.delivery). TY_API_BASE متاح للتغيير لو تغير العنوان.
بدون هذه المتغيرات تعمل الموصلات التمهيدية (stubs) وتبقى الحسابات بحالة needs_setup.

## ماذا بعد؟
- اعتماد حساب شريك لدى هنقرستيشن، أو حساب تاجر حقيقي بموافقة مكتوبة لاختبار موصل تويو.
- بناء محددات بوابات المنصات الأخرى مع أول حساب تاجر حقيقي.
- الانتقال إلى PostgreSQL عند أول 5 تجار.

## تنبيهات مهمة
- لا تشغل النظام على HTTP مكشوف أبدا. HTTPS فقط.
- باسووردات التجار تخزن مشفرة، ولا تظهر في أي رد من النظام.
- السحب الآلي من البوابات قد يخالف شروط بعض التطبيقات؛ الأولوية دائما للربط الرسمي.
