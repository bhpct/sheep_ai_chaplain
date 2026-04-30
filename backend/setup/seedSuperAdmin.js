const { admin, db } = require('../src/config/firebaseAdmin');

async function seedSuperAdmin() {
    const superAdminUid = 'U8b8bcd3867bee33a86a7063b430ebb2a';
    
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
