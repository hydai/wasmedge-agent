use ledger::{calc_total, report::summary, Entry};

#[test]
fn totals_add_up() {
    let entries = vec![Entry { amount: 3 }, Entry { amount: 7 }];
    assert_eq!(calc_total(&entries), 10);
}

#[test]
fn summary_formats() {
    let entries = vec![Entry { amount: 5 }];
    assert_eq!(summary(&entries), "total=5");
}
