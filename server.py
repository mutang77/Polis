import http.server
import socketserver
import json
import csv
import os

PORT = 8000

class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/data':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            
            data = []
            csv_path = 'pdrm_selangor_crime_data_2025.csv'
            if os.path.exists(csv_path):
                with open(csv_path, mode='r', encoding='utf-8') as f:
                    reader = csv.reader(f)
                    header = next(reader, None) # skip header
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
            self.wfile.write(json.dumps(data).encode('utf-8'))
        elif self.path == '/api/geojson':
            geojson_path = 'selangor_districts.geojson'
            if os.path.exists(geojson_path):
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                with open(geojson_path, mode='r', encoding='utf-8') as f:
                    self.wfile.write(f.read().encode('utf-8'))
            else:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b'{"error": "GeoJSON not found"}')
        else:
            # Serve static files (index.html, styles.css, app.js, etc.)
            super().do_GET()

if __name__ == '__main__':
    # Ensure working directory is the file's directory
    file_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(file_dir)
    # Enable address reuse to avoid port binding errors on restarts
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), DashboardHandler) as httpd:
        print(f"Serving PDRM Selangor dashboard at http://localhost:{PORT}")
        print(f"  Dashboard: http://localhost:{PORT}/")
        print(f"  API Data:  http://localhost:{PORT}/api/data")
        print(f"  GeoJSON:   http://localhost:{PORT}/api/geojson")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
