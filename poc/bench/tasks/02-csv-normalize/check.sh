#!/bin/bash
set -e
node -e '
const fs = require("fs");
const got = JSON.parse(fs.readFileSync(process.env.PROJECT_DIR + "/users.json", "utf8"));
const want = [
  {id:1,name:"Alice Smith",email:"alice@example.com",age:34,active:true},
  {id:2,name:"Bob Jones",email:"bob@example.com",age:41,active:false},
  {id:3,name:"Carol White",email:"carol@example.com",age:28,active:true},
  {id:4,name:"Dan Brown",email:"dan@example.com",age:55,active:false},
];
const norm = (a) => JSON.stringify(a.map(o => ({id:o.id,name:o.name,email:o.email,age:o.age,active:o.active})));
if (norm(got) !== JSON.stringify(want)) { console.error("mismatch:\n" + norm(got)); process.exit(1); }
'
