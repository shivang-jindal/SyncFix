import fs from 'fs';

const file = 'server/src/services/connection.service.ts';
let content = fs.readFileSync(file, 'utf8');

// Fix recentTestRuns return type
content = content.replace(
  /\.then\(\(rows\) =>\s*rows\.map\(\(row\) => \(\{\s*\.\.\.row,\s*status:\s*\(row\.status === 'passed' \? 'passed' : 'failed'\) as 'passed' \| 'failed',\s*\}\)\s*\),/g,
  ".then((rows): ConnectionTestRun[] => rows.map((row): ConnectionTestRun => ({ ...row, status: (row.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed' }))"
);

// Fix the test function return type
content = content.replace(
  /const \[testRun\] = await this\.db\s*\.\s*insert\(connectionTestRuns\)\s*\.\s*values\(\{\s*organizationId: input\.organizationId,\s*connectionId: connection\.id,\s*status: result\.ok \? 'passed' : 'failed',/g,
  `const [testRun] = await this.db
      .insert(connectionTestRuns)
      .values({
        organizationId: input.organizationId,
        connectionId: connection.id,
        status: result.ok ? 'passed' : 'failed',`
);

fs.writeFileSync('server/src/services/connection.service.ts', content, 'utf8');
console.log('Fixed connection.service.ts');