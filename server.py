import http.server
import socketserver
import json
import csv
import os
import io
import uuid
import time
import re
import cgi

PORT = 8000

# Simple in-memory session store and user database
# In production, use proper database and hashing
USERS = {
    'admin': { 'password': 'pdrm2025', 'name': 'Admin IPK Selangor', 'role': 'admin' },
    'pegawai': { 'password': 'polis123', 'name': 'Pegawai Ops', 'role': 'user' },
}

SESSIONS = {}  # token -> { user, role, created }

CSV_FILENAME = 'pdrm_selangor_crime_data_2025.csv'

def read_csv_data(csv_path=None):
    """Parse the CSV file and return list of dicts."""
    if csv_path is None:
        csv_path = CSV_FILENAME
    data = []
    if os.path.exists(csv_path):
        with open(csv_path, mode='r', encoding='utf-8') as f:
            reader = csv.reader(f)
            header = next(reader, None)
            for row in reader:
                if not row or len(row) < 6:
                    continue
                try:
                    data.append({
                        'tahun': int(row[0].strip()),
                        'ipd': row[1].strip(),
                        'kategori': row[2].strip(),
                        'jenis': row[3].strip(),
                        'dilaporkan': int(row[4].strip()),
                        'penyelesaian': int(row[5].strip())
                    })
                except ValueError:
                    continue
    return data

def validate_session(token):
    """Check if a session token is valid."""
    if not token:
        return None
    session = SESSIONS.get(token)
    if session:
        # Session valid for 2 hours
        if time.time() - session['created'] < 7200:
            return session
        else:
            del SESSIONS[token]
    return None

class DashboardHandler(http.server.SimpleHTTPRequestHandler):

    def send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def get_token_from_header(self):
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            return auth[7:]
        return None

    def do_GET(self):
        # Redirect root to login page
        if self.path == '/' or self.path == '':
            self.send_response(302)
            self.send_header('Location', '/login.html')
            self.end_headers()
            return

        if self.path == '/api/data':
            data = read_csv_data()
            self.send_json(200, data)

        elif self.path == '/api/geojson':
            geojson_path = 'selangor_districts.geojson'
            if os.path.exists(geojson_path):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                with open(geojson_path, mode='r', encoding='utf-8') as f:
                    self.wfile.write(f.read().encode('utf-8'))
            else:
                self.send_json(404, {'error': 'GeoJSON not found'})

        elif self.path == '/api/session':
            token = self.get_token_from_header()
            session = validate_session(token)
            if session:
                self.send_json(200, {'valid': True, 'user': session['user'], 'role': session['role']})
            else:
                self.send_json(401, {'valid': False})
        else:
            super().do_GET()

    def do_POST(self):
        content_type = self.headers.get('Content-Type', '')
        content_length = int(self.headers.get('Content-Length', 0))

        if self.path == '/api/login':
            try:
                body = self.rfile.read(content_length)
                payload = json.loads(body.decode('utf-8'))
                username = payload.get('username', '').strip()
                password = payload.get('password', '')

                user = USERS.get(username)
                if user and user['password'] == password:
                    token = str(uuid.uuid4())
                    SESSIONS[token] = {
                        'user': user['name'],
                        'role': user['role'],
                        'username': username,
                        'created': time.time()
                    }
                    self.send_json(200, {
                        'success': True,
                        'token': token,
                        'user': user['name'],
                        'role': user['role']
                    })
                else:
                    time.sleep(0.5)  # Slow down brute force
                    self.send_json(401, {
                        'success': False,
                        'message': 'Nama pengguna atau kata laluan salah. Sila cuba semula.'
                    })
            except Exception as e:
                self.send_json(400, {'success': False, 'message': str(e)})

        elif self.path == '/api/upload':
            # Handle CSV file upload
            token = self.get_token_from_header()
            session = validate_session(token)
            if not session:
                self.send_json(401, {'success': False, 'message': 'Sesi tidak sah. Sila log masuk semula.'})
                return

            try:
                # Parse multipart form data
                if 'multipart/form-data' in content_type:
                    boundary = content_type.split('boundary=')[1].strip()
                    body = self.rfile.read(content_length)
                    
                    # Find the file content between boundaries
                    parts = body.split(('--' + boundary).encode())
                    csv_content = None
                    original_filename = 'uploaded.csv'
                    
                    for part in parts:
                        part_str = part.decode('utf-8', errors='replace')
                        if 'filename=' in part_str and 'Content-Type' in part_str:
                            # Extract filename
                            fname_match = re.search(r'filename="([^"]+)"', part_str)
                            if fname_match:
                                original_filename = fname_match.group(1)
                            
                            # Extract CSV content (after the double newline)
                            header_end = part.find(b'\r\n\r\n')
                            if header_end == -1:
                                header_end = part.find(b'\n\n')
                            if header_end != -1:
                                csv_content = part[header_end:].strip()
                                # Remove trailing boundary markers
                                if csv_content.endswith(b'--'):
                                    csv_content = csv_content[:-2].strip()
                                if csv_content.endswith(b'\r\n'):
                                    csv_content = csv_content[:-2]

                    if csv_content is None:
                        self.send_json(400, {'success': False, 'message': 'Tiada fail CSV ditemui dalam permintaan.'})
                        return

                    # Validate CSV structure
                    csv_text = csv_content.decode('utf-8', errors='replace')
                    reader = csv.reader(io.StringIO(csv_text))
                    header = next(reader, None)
                    
                    if header is None or len(header) < 6:
                        self.send_json(400, {
                            'success': False,
                            'message': f'Format CSV tidak sah. Dijangka 6 kolum (Tahun, IPD, Kategori, Jenis, Dilaporkan, Penyelesaian) tetapi hanya {len(header) if header else 0} kolum ditemui.'
                        })
                        return

                    row_count = 0
                    for row in reader:
                        if row and len(row) >= 6:
                            row_count += 1
                    
                    if row_count == 0:
                        self.send_json(400, {'success': False, 'message': 'Fail CSV tiada rekod data.'})
                        return

                    # Save the uploaded file (overwrite existing)
                    with open(CSV_FILENAME, 'wb') as f:
                        f.write(csv_content)

                    self.send_json(200, {
                        'success': True,
                        'message': f'Berjaya! {row_count} rekod dari "{original_filename}" telah dimuat naik dan diproses.',
                        'rows': row_count,
                        'filename': original_filename
                    })
                else:
                    self.send_json(400, {'success': False, 'message': 'Content-Type mesti multipart/form-data.'})

            except Exception as e:
                self.send_json(500, {'success': False, 'message': f'Ralat pelayan: {str(e)}'})

        elif self.path == '/api/logout':
            token = self.get_token_from_header()
            if token and token in SESSIONS:
                del SESSIONS[token]
            self.send_json(200, {'success': True, 'message': 'Berjaya log keluar.'})

        else:
            self.send_json(404, {'error': 'Endpoint tidak ditemui'})


if __name__ == '__main__':
    file_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(file_dir)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), DashboardHandler) as httpd:
        print(f"\n{'='*60}")
        print(f"  PDRM Selangor Crime Analytics Server")
        print(f"{'='*60}")
        print(f"  Dashboard : http://localhost:{PORT}/")
        print(f"  Login     : http://localhost:{PORT}/login.html")
        print(f"  API Data  : http://localhost:{PORT}/api/data")
        print(f"  GeoJSON   : http://localhost:{PORT}/api/geojson")
        print(f"{'='*60}")
        print(f"  Default Login:")
        print(f"    Username: admin    Password: pdrm2025")
        print(f"    Username: pegawai  Password: polis123")
        print(f"{'='*60}\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
