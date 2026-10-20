import fs from 'fs';

const file = 'server/src/services/connection.service.ts';
let content = fs.readFileSync(file, 'utf8');

// Fix recentTestRuns to convert testedAt to ISO string
content = content.replace(
  /async recentTestRuns\(connectionId: string, limit = 10\): Promise<ConnectionTestRun\[\]> \{\s*return this\.db\s*\.\s*select\(\)\s*\.\s*from\(connectionTestRuns\)\s*\.\s*where\(eq\(connectionTestRuns\.connectionId, connectionId\)\)\s*\.\s*orderBy\(desc\(connectionTestRuns\.testedAt\)\)\s*\.\s*limit\(Math\.min\(limit, 50\)\)\s*\.\s*then\(\(rows\): ConnectionTestRun\[\] => rows\.map\(\(row\): ConnectionTestRun => \(\{\s*\.\.\.row,\s*status: \(row\.status === 'passed' \? 'passed' : 'failed'\) as 'passed' \| 'failed',\s*\}\)\s*\)\s*\);/g,
  `async recentTestRuns(connectionId: string, limit = 10): Promise<ConnectionTestRun[]> {\n    return this.db\n      .select()\n      .from(connectionTestRuns)\n      .where(eq(connectionTestRuns.connectionId, connectionId))\n      .orderBy(desc(connectionTestRuns.testedAt))\n      .limit(Math.min(limit, 50))\n      .then((rows): ConnectionTestRun[] =>\n        rows.map((row): ConnectionTestRun => ({\n          ...row,\n          status: (row.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',\n          testedAt: row.testedAt instanceof Date ? row.testedAt.toISOString() : String(row.testedAt),\n        }))\n      );`
);

fs.writeFileSync('server/src/services/connection.service.ts', content, 'utf8');
console.log('Fixed connection.service.ts');