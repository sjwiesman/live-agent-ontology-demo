FROM node:20-alpine

WORKDIR /app

# Corporate-proxy friendly: if the build context provides extra CA
# certificates (*.crt), have node trust them for package downloads.
COPY package*.json *.crt ./
RUN cat ./*.crt > /app/extra-ca.crt 2>/dev/null || touch /app/extra-ca.crt
ENV NODE_EXTRA_CA_CERTS=/app/extra-ca.crt

RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host"]
