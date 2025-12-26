FROM node:18

# Instalar Python y pdfplumber
RUN apt-get update && apt-get install -y python3 python3-pip
RUN pip3 install pdfplumber --break-system-packages

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 4000
CMD ["node", "server.js"]
