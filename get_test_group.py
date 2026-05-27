import psycopg2
conn = psycopg2.connect(host='127.0.0.1', port=5432, dbname='unicomm_db', user='postgres', password='')
cur = conn.cursor()
cur.execute("SELECT id, name FROM recipient_groups WHERE LOWER(name) LIKE '%test%'")
groups = cur.fetchall()
print('Groups:', groups)
if groups:
    gid = groups[0][0]
    cur.execute("""
        SELECT c.fname, c.lname, c.email 
        FROM recipient_group_members m 
        JOIN contacts c ON c.id = m.contact_id 
        WHERE m.group_id = %s AND c.email IS NOT NULL AND c.email != ''
    """, (gid,))
    members = cur.fetchall()
    print('Members:')
    for m in members:
        print(' ', m)
conn.close()
