const { admin, db } = require('../src/config/firebaseAdmin');

async function seedSuperAdmin() {
    const superAdminUid = 'U03cbd4480cec1268f98ef8c762f6e88e';
    
    try {
        const userRef = db.collection('Users').doc(superAdminUid);
        await userRef.set({
            line_uid: superAdminUid,
            hosp_id: 'ALL',
            role: 'super_admin',
            displayName: 'System Developer',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`✅ 成功將 ${superAdminUid} 設為 super_admin`);
        process.exit(0);
    } catch (e) {
        console.error("設定失敗:", e);
        process.exit(1);
    }
}

seedSuperAdmin();
