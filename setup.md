bash
unzip ledger-rail-app.zip && cd ledger-rail-app
docker compose up -d db          # starts Postgres, or use your own install
cp .env.example .env             # then fill in ANTHROPIC_API_KEY if you want AI Insights
npm install
npm run db:setup                 # creates all tables
npm start



Dropdown ==> Source
Setup Cost categories/groups ==> setup_cost_categories
Event Type ==> dropdown_options
Contribution Category ==> dropdown_options
Loan Type ==> dropdown_options
Partner (contributions) ==> partners table
Loan (EMI payments) ==> loans table
Paid By (setup costs) ==> partners table

