const { admin, db } = require('./backend/src/config/firebaseAdmin');

async function checkLogs() {
    const snapshot = await db.collection('CareLogs').where('transcript', '==', 'Today is very bad. My heart is broken.').get();
    snapshot.forEach(doc => {
        console.log(doc.id, doc.data());
    });
}
checkLogs();
